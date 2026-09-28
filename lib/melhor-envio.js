/**
 * OAuth 2.0 do Melhor Envio — com refresh automático, igual ao Bling.
 *
 * Por que assim (e não um token cru no env): o token do Melhor Envio expira.
 * Um token colado na Vercel funcionaria por algumas semanas e depois o frete
 * pararia sem aviso. Aqui os tokens ficam na tabela `melhor_envio_tokens` do
 * Supabase (uma linha só) e renovam sozinhos: cada cotação que chega perto do
 * vencimento dispara o refresh (o `refresh_token` é rotacionado, como no Bling),
 * e o cron diário mantém o token quente mesmo em dia parado.
 *
 * A conexão inicial é feita UMA vez pelo `scripts/melhor-envio-conectar.js`
 * (loopback em localhost — nenhuma função nova na Vercel, que já está no teto
 * de 12 do plano Hobby). O único segredo que este arquivo toca é o
 * client_id/client_secret do app, via env var.
 *
 * Variáveis de ambiente:
 *   MELHOR_ENVIO_CLIENT_ID       Client Id do app (Melhor Envio → Integrações → Área Dev)
 *   MELHOR_ENVIO_CLIENT_SECRET   Client Secret do mesmo app
 *   MELHOR_ENVIO_REDIRECT_URI    redirect do app (padrão http://localhost:8790/callback — o do script)
 *   MELHOR_ENVIO_AMBIENTE        'production' (padrão) | 'sandbox'
 *   MELHOR_ENVIO_ESCOPO          escopos OAuth (padrão 'shipping-calculate' — só cotar)
 *   MELHOR_ENVIO_USER_AGENT      identificação exigida pela API (padrão com o e-mail de contato)
 *   MELHOR_ENVIO_TOKEN           OPCIONAL: um access_token cru pra usar direto (pula o OAuth;
 *                                útil só pra um teste rápido — expira e não renova)
 */
import crypto from 'node:crypto';
import { exigirSupabase, supabase } from './supabase.js';

const BASES = {
  production: 'https://melhorenvio.com.br',
  sandbox: 'https://sandbox.melhorenvio.com.br',
};

// O Melhor Envio exige redirect https, então usamos o próprio backend. A rota
// /api/melhor-envio/callback é um rewrite (vercel.json) pro handler compartilhado
// api/bling/callback.js — não gasta função nova (plano Hobby limita a 12).
export const REDIRECT_PADRAO = 'https://api.soarmacao.com.br/api/melhor-envio/callback';
const MARGEM_REFRESH_MS = 3 * 24 * 60 * 60_000; // renova faltando 3 dias

export class MelhorEnvioAuthError extends Error {
  constructor(status, mensagem, corpo) {
    super(mensagem);
    this.name = 'MelhorEnvioAuthError';
    this.status = status;
    this.corpo = corpo;
  }
}

function ambiente() {
  return (process.env.MELHOR_ENVIO_AMBIENTE || 'production').toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
}
export function baseUrl() { return BASES[ambiente()]; }
export function escopo() { return process.env.MELHOR_ENVIO_ESCOPO || 'shipping-calculate'; }
export function redirectUri() { return process.env.MELHOR_ENVIO_REDIRECT_URI || REDIRECT_PADRAO; }
export function userAgent() { return process.env.MELHOR_ENVIO_USER_AGENT || 'Só Armação (contato@soarmacao.com.br)'; }

function credenciais() {
  const id = process.env.MELHOR_ENVIO_CLIENT_ID;
  const secret = process.env.MELHOR_ENVIO_CLIENT_SECRET;
  if (!id || !secret) throw new MelhorEnvioAuthError(500, 'MELHOR_ENVIO_CLIENT_ID / MELHOR_ENVIO_CLIENT_SECRET nao configurados.');
  return { id, secret };
}

/**
 * `state` assinado com o CRON_SECRET e marcado com o prefixo "me." — o callback
 * compartilhado (api/bling/callback.js) usa o prefixo pra saber que é Melhor
 * Envio, e a assinatura garante que só autorizações iniciadas por nós valem.
 */
export function gerarState() {
  const seg = process.env.CRON_SECRET || '';
  const nonce = crypto.randomBytes(12).toString('hex');
  const ts = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', seg).update(`me.${nonce}.${ts}`).digest('hex').slice(0, 24);
  return `me.${nonce}.${ts}.${sig}`;
}

export function stateValido(state) {
  const p = String(state || '').split('.');
  if (p.length !== 4 || p[0] !== 'me') return false;
  const [, nonce, ts, sig] = p;
  const seg = process.env.CRON_SECRET || '';
  const esp = crypto.createHmac('sha256', seg).update(`me.${nonce}.${ts}`).digest('hex').slice(0, 24);
  const a = Buffer.from(sig), b = Buffer.from(esp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const idade = Date.now() - parseInt(ts, 36);
  return idade >= 0 && idade < 15 * 60_000; // 15 min pra concluir
}

/** URL de consentimento pra abrir no navegador logado no Melhor Envio. */
export function urlAutorizacao(state) {
  // Só o client_id vai na URL — o secret é usado depois, na troca do code
  // (no callback do backend), então quem monta a URL não precisa dele.
  const id = process.env.MELHOR_ENVIO_CLIENT_ID;
  if (!id) throw new MelhorEnvioAuthError(500, 'MELHOR_ENVIO_CLIENT_ID nao configurado.');
  const q = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: escopo(),
    ...(state ? { state } : {}),
  });
  return `${baseUrl()}/oauth/authorize?${q.toString()}`;
}

async function pedirToken(extra) {
  const { id, secret } = credenciais();
  const res = await fetch(`${baseUrl()}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent() },
    body: JSON.stringify({ client_id: id, client_secret: secret, ...extra }),
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok || !corpo.access_token) {
    const msg = corpo.error_description || corpo.message || corpo.error || 'sem detalhe';
    throw new MelhorEnvioAuthError(res.status, `OAuth Melhor Envio falhou (${res.status}): ${msg}`, corpo);
  }
  return corpo;
}

async function salvarTokens(t) {
  const db = exigirSupabase();
  const expiraEm = new Date(Date.now() + (Number(t.expires_in) || 0) * 1000).toISOString();
  const { error } = await db.from('melhor_envio_tokens').upsert({
    id: 1,
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    expira_em: expiraEm,
    escopo: t.scope || escopo(),
    atualizado_em: new Date().toISOString(),
  });
  if (error) throw new Error(`Falha ao gravar tokens do Melhor Envio: ${error.message}`);
  return { access_token: t.access_token, refresh_token: t.refresh_token, expira_em: expiraEm };
}

/** Troca o `code` do consentimento por tokens e grava. Usado pelo script de conexão. */
export async function concluirAutorizacao(code) {
  const t = await pedirToken({ grant_type: 'authorization_code', redirect_uri: redirectUri(), code });
  return salvarTokens(t);
}

async function lerTokens() {
  const db = exigirSupabase();
  const { data, error } = await db.from('melhor_envio_tokens').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Falha ao ler tokens do Melhor Envio: ${error.message}`);
  return data;
}

export async function melhorEnvioConectado() {
  if (!supabase) return false;
  try { return Boolean(await lerTokens()); } catch { return false; }
}

let tokenEmMemoria = null; // cache por instância (dura só a execução)

async function refresh(tokens) {
  if (!tokens.refresh_token) throw new MelhorEnvioAuthError(401, 'Sem refresh_token — reconecte com scripts/melhor-envio-conectar.js.');
  try {
    const t = await pedirToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: escopo() });
    return await salvarTokens(t);
  } catch (e) {
    // Outra execução pode ter refrescado (o refresh_token é rotacionado):
    // relê antes de desistir.
    const atual = await lerTokens();
    if (atual && atual.refresh_token && atual.refresh_token !== tokens.refresh_token) return atual;
    throw e;
  }
}

/**
 * Access token válido. Renova sozinho quando falta menos de MARGEM_REFRESH_MS.
 * Lança MelhorEnvioAuthError se não estiver conectado (o chamador — frete.js —
 * cai na tabela fixa nesse caso).
 */
export async function obterAccessToken({ forcarRefresh = false } = {}) {
  // Override manual (teste rápido): um token cru no env pula o Supabase.
  if (process.env.MELHOR_ENVIO_TOKEN) return process.env.MELHOR_ENVIO_TOKEN;

  let tokens = tokenEmMemoria || await lerTokens();
  if (!tokens) throw new MelhorEnvioAuthError(401, 'Melhor Envio nao conectado. Rode scripts/melhor-envio-conectar.js.');
  const expira = new Date(tokens.expira_em).getTime();
  if (forcarRefresh || !Number.isFinite(expira) || expira - Date.now() < MARGEM_REFRESH_MS) {
    tokens = await refresh(tokens);
  }
  tokenEmMemoria = tokens;
  return tokens.access_token;
}

/**
 * Mantém o token quente (chamado pelo cron diário). Nunca lança: um erro aqui
 * não pode derrubar a reconciliação. Devolve um resumo curto pro log.
 */
export async function manterTokenVivo() {
  if (process.env.MELHOR_ENVIO_TOKEN) return { ok: true, fonte: 'env' };
  try {
    if (!(await melhorEnvioConectado())) return { ok: false, motivo: 'nao conectado' };
    await obterAccessToken();
    return { ok: true };
  } catch (e) {
    console.error('[melhor-envio] manterTokenVivo:', e.message);
    return { ok: false, motivo: e.message };
  }
}
