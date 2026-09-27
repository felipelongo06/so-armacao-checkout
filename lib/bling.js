/**
 * Cliente da API v3 do Bling — OAuth 2.0 + chamadas com limite de taxa.
 *
 * Único lugar que toca client_id / client_secret e os tokens. Os tokens ficam
 * na tabela `bling_tokens` do Supabase (uma linha só), porque a função
 * serverless é efêmera: cada execução precisa reencontrar o refresh_token.
 *
 * Regras da API que este arquivo respeita:
 *   - 3 requisições/segundo por conta (HTTP 429 acima disso).
 *   - access_token vale 6 h; refresh_token vale 30 dias e é ROTACIONADO a cada
 *     refresh (o novo substitui o antigo — se não gravar, perde a conexão).
 *   - client_id:client_secret vão em Basic Auth no endpoint de token.
 */
import crypto from 'node:crypto';
import { exigirSupabase } from './supabase.js';

const API = 'https://www.bling.com.br/Api/v3';
const INTERVALO_MS = 350;      // ~2,8 req/s, abaixo do limite de 3
const MARGEM_REFRESH_MS = 10 * 60_000;

export class BlingError extends Error {
  constructor(status, mensagem, corpo) {
    super(mensagem);
    this.name = 'BlingError';
    this.status = status;
    this.corpo = corpo;
  }
}

function credenciais() {
  const id = process.env.BLING_CLIENT_ID;
  const secret = process.env.BLING_CLIENT_SECRET;
  if (!id || !secret) throw new Error('BLING_CLIENT_ID / BLING_CLIENT_SECRET nao configurados.');
  return { id, secret };
}

export function redirectUri() {
  return process.env.BLING_REDIRECT_URI || 'https://api.soarmacao.com.br/api/bling/callback';
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** `state` assinado com o CRON_SECRET: o callback só aceita o que o /auth gerou. */
export function gerarState() {
  const segredo = process.env.CRON_SECRET || '';
  const nonce = crypto.randomBytes(12).toString('hex');
  const ts = Date.now().toString(36);
  const assinatura = crypto.createHmac('sha256', segredo).update(`${nonce}.${ts}`).digest('hex').slice(0, 24);
  return `${nonce}.${ts}.${assinatura}`;
}

export function stateValido(state) {
  const partes = String(state || '').split('.');
  if (partes.length !== 3) return false;
  const [nonce, ts, assinatura] = partes;
  const segredo = process.env.CRON_SECRET || '';
  const esperada = crypto.createHmac('sha256', segredo).update(`${nonce}.${ts}`).digest('hex').slice(0, 24);
  const a = Buffer.from(assinatura); const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const idade = Date.now() - parseInt(ts, 36);
  return idade >= 0 && idade < 15 * 60_000; // 15 minutos pra concluir a autorização
}

export function urlAutorizacao(state) {
  const { id } = credenciais();
  const q = new URLSearchParams({ response_type: 'code', client_id: id, state });
  return `${API}/oauth/authorize?${q.toString()}`;
}

async function pedirToken(params) {
  const { id, secret } = credenciais();
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '1.0',
    },
    body: new URLSearchParams(params).toString(),
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok || !corpo.access_token) {
    throw new BlingError(res.status, `Bling OAuth falhou (${res.status}): ${corpo.error_description || corpo.error || 'sem detalhe'}`, corpo);
  }
  return corpo;
}

async function salvarTokens(t) {
  const db = exigirSupabase();
  const expiraEm = new Date(Date.now() + (Number(t.expires_in) || 21600) * 1000).toISOString();
  const { error } = await db.from('bling_tokens').upsert({
    id: 1,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expira_em: expiraEm,
    escopo: t.scope || null,
    atualizado_em: new Date().toISOString(),
  });
  if (error) throw new Error(`Falha ao gravar tokens do Bling: ${error.message}`);
  return { access_token: t.access_token, refresh_token: t.refresh_token, expira_em: expiraEm };
}

/** Troca o `code` do callback por tokens e grava. */
export async function concluirAutorizacao(code) {
  const t = await pedirToken({ grant_type: 'authorization_code', code });
  return salvarTokens(t);
}

async function lerTokens() {
  const db = exigirSupabase();
  const { data, error } = await db.from('bling_tokens').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Falha ao ler tokens do Bling: ${error.message}`);
  return data;
}

export async function blingConectado() {
  try { return Boolean(await lerTokens()); } catch { return false; }
}

let tokenEmMemoria = null; // cache por instância (dura só a execução)

async function refresh(tokens) {
  try {
    const t = await pedirToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    return await salvarTokens(t);
  } catch (e) {
    // Outra execução pode ter feito o refresh (o refresh_token é rotacionado).
    // Relê antes de desistir: se o banco já tem um token novo, usa ele.
    const atual = await lerTokens();
    if (atual && atual.refresh_token !== tokens.refresh_token) return atual;
    throw e;
  }
}

export async function obterAccessToken({ forcarRefresh = false } = {}) {
  let tokens = tokenEmMemoria || await lerTokens();
  if (!tokens) throw new BlingError(401, 'Bling nao conectado. Abra /api/bling/auth pra autorizar.');
  const expira = new Date(tokens.expira_em).getTime();
  if (forcarRefresh || expira - Date.now() < MARGEM_REFRESH_MS) {
    tokens = await refresh(tokens);
  }
  tokenEmMemoria = tokens;
  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Chamadas à API (fila serial com espaçamento, retry em 429 e refresh em 401)
// ---------------------------------------------------------------------------

let ultimaChamada = 0;
let fila = Promise.resolve();

function agendar(fn) {
  const p = fila.then(async () => {
    const espera = ultimaChamada + INTERVALO_MS - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaChamada = Date.now();
    return fn();
  });
  fila = p.catch(() => {});
  return p;
}

function montarUrl(path, query) {
  const url = new URL(`${API}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * bling('GET', '/produtos', { query: { pagina: 1 } })
 * bling('PATCH', '/produtos/123', { body: {...} })
 */
export async function bling(method, path, { query, body } = {}) {
  const url = montarUrl(path, query);
  let tentativas = 0;
  let refreshFeito = false;

  while (true) {
    tentativas++;
    const token = await obterAccessToken();
    const res = await agendar(() => fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }));

    if (res.status === 429 && tentativas <= 4) {
      await new Promise((r) => setTimeout(r, 1200 * tentativas));
      continue;
    }
    if (res.status === 401 && !refreshFeito) {
      refreshFeito = true;
      tokenEmMemoria = null;
      await obterAccessToken({ forcarRefresh: true });
      continue;
    }
    if (res.status === 204) return null;

    const texto = await res.text();
    let corpo = null;
    try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = { bruto: texto }; }

    if (!res.ok) {
      const msg = corpo?.error?.description || corpo?.error?.message || corpo?.error?.type || texto.slice(0, 200);
      throw new BlingError(res.status, `Bling ${method} ${path} -> ${res.status}: ${msg}`, corpo);
    }
    return corpo;
  }
}

/** Percorre todas as páginas de uma listagem (limite 100 por página). */
export async function blingTodas(path, query = {}) {
  const limite = Number(query.limite || 100);
  const tudo = [];
  for (let pagina = 1; pagina < 200; pagina++) {
    const r = await bling('GET', path, { query: { ...query, pagina, limite } });
    const dados = r?.data || [];
    tudo.push(...dados);
    if (dados.length < limite) break;
  }
  return tudo;
}

/** Assinatura dos webhooks: HMAC-SHA256(payload bruto, client_secret), hex. */
export function assinaturaWebhookValida(corpoBruto, header) {
  const { secret } = credenciais();
  const esperado = crypto.createHmac('sha256', secret).update(corpoBruto, 'utf8').digest('hex');
  const recebido = String(header || '').replace(/^sha256=/, '').trim();
  const a = Buffer.from(esperado); const b = Buffer.from(recebido);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
