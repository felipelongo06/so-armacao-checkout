/**
 * POST /api/bling/webhook
 *
 * Recebe os eventos do Bling (configurados na aba Webhooks do app em
 * developer.bling.com.br) e mantém `produtos` em dia sem esperar o cron:
 *
 *   produto.created / produto.updated  → ressincroniza o pai inteiro
 *   produto.deleted                    → desativa (pai ou variação)
 *   estoque.updated / estoque_virtual  → grava o saldo virtual do produto
 *
 * Regras do Bling que este handler respeita:
 *   - Responder 2xx em até 5 s (senão entra em retentativa por 3 dias e, se
 *     continuar falhando, o Bling DESLIGA o webhook). Por isso o trabalho
 *     pesado é curto e erro nosso devolve 200 com `ok:false` no corpo.
 *   - Assinatura HMAC-SHA256 do payload BRUTO com o client_secret, no header
 *     X-Bling-Signature-256 ("sha256=<hex>"). Inválida → 401.
 *   - Idempotente: o mesmo eventId pode chegar mais de uma vez.
 *
 * Usa a assinatura Web (Request/Response) da Vercel de propósito: é o jeito
 * de ler o corpo bruto sem o parser automático mexer nele, e o HMAC precisa
 * dos bytes exatos que o Bling mandou.
 */
import { assinaturaWebhookValida } from '../../lib/bling.js';
import { exigirSupabase } from '../../lib/supabase.js';
import { sincronizarProdutoBling, desativarProdutoBling, atualizarEstoqueBling } from '../../lib/catalogo-sync.js';

function json(corpo, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function classificar(evento, data) {
  const e = String(evento || '').toLowerCase();
  const recurso = e.split('.')[0];
  const acao = e.split('.')[1] || '';
  if (/^(estoque|stock)/.test(recurso) || (data?.produto?.id && data?.saldoVirtualTotal != null)) return { tipo: 'estoque', acao };
  if (/^(produto|product)$/.test(recurso) || (data?.id && (data?.codigo || data?.nome))) return { tipo: 'produto', acao };
  return { tipo: 'outro', acao };
}

export async function POST(request) {
  const bruto = await request.text();
  const assinatura = request.headers.get('x-bling-signature-256');

  if (!assinaturaWebhookValida(bruto, assinatura)) {
    console.warn('[bling/webhook] assinatura invalida');
    return json({ erro: 'Assinatura invalida.' }, 401);
  }

  let evento;
  try { evento = JSON.parse(bruto); } catch { return json({ ok: true, ignorado: 'corpo nao e JSON' }); }

  const data = evento?.data || {};
  const { tipo, acao } = classificar(evento?.event, data);
  const blingId = tipo === 'estoque' ? data?.produto?.id : data?.id;
  if (!blingId) return json({ ok: true, ignorado: 'sem id de produto' });

  try {
    const db = exigirSupabase();
    const eventoId = String(evento.eventId || `${evento.event}:${blingId}:${evento.date || Date.now()}`);
    const { error: dup } = await db.from('bling_webhook_eventos')
      .insert({ id: eventoId, evento: String(evento.event || ''), bling_id: blingId, payload: evento });
    if (dup) {
      if (dup.code === '23505') return json({ ok: true, duplicado: true });
      throw dup;
    }

    let resultado;
    if (tipo === 'estoque') {
      const saldo = data.saldoVirtualTotal ?? data.saldoFisicoTotal ?? 0;
      resultado = { estoque: saldo, linhas: await atualizarEstoqueBling(blingId, saldo) };
    } else if (tipo === 'produto' && acao === 'deleted') {
      await desativarProdutoBling(blingId);
      resultado = { desativado: blingId };
    } else if (tipo === 'produto') {
      resultado = await sincronizarProdutoBling(blingId, { origem: 'webhook' });
    } else {
      resultado = { ignorado: evento.event };
    }

    console.log('[bling/webhook] %s id=%s -> %o', evento.event, blingId, resultado);
    return json({ ok: true, ...resultado });
  } catch (e) {
    // 200 de propósito: erro nosso não pode derrubar a fila do Bling. O cron diário corrige.
    console.error('[bling/webhook] erro:', e);
    return json({ ok: false, erro: e.message });
  }
}

export async function GET() {
  return json({ erro: 'Use POST.' }, 405);
}
