/**
 * POST /api/webhook-asaas
 *
 * FONTE DA VERDADE do pagamento. Regras:
 *  1. Autentica pelo header `asaas-access-token` (comparacao em tempo constante).
 *  2. Idempotente — o Asaas reenvia eventos; o mesmo event id nunca processa 2x.
 *  3. Confere o valor pago contra o valor do pedido antes de liberar.
 *  4. Responde 200 rapido; se devolver erro, o Asaas pausa a fila.
 */
import { asaas } from '../lib/asaas.js';
import { supabase, exigirSupabase } from '../lib/supabase.js';
import { compararSegredo } from '../lib/validacao.js';
import { dispararConversao } from '../lib/tracking.js';
import { criarPedidoNoBling } from '../lib/bling-pedido.js';

const PAGO = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH']);
const DEVOLVIDO = new Set(['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Metodo nao permitido.' });

  // ---- 1. autenticacao ----
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!esperado) {
    console.error('[webhook] ASAAS_WEBHOOK_TOKEN nao configurado.');
    return res.status(500).json({ erro: 'Webhook nao configurado.' });
  }
  if (!compararSegredo(req.headers['asaas-access-token'], esperado)) {
    console.warn('[webhook] token invalido.');
    return res.status(401).json({ erro: 'Nao autorizado.' });
  }

  const evento = req.body || {};
  const { event, payment } = evento;
  if (!event || !payment?.id) return res.status(200).json({ ok: true, ignorado: 'payload sem evento/pagamento' });

  try {
    const db = exigirSupabase();

    // ---- 2. idempotencia ----
    const eventoId = evento.id || `${event}:${payment.id}:${payment.status}`;
    const { error: dupErro } = await db.from('webhook_eventos')
      .insert({ id: eventoId, evento: event, payment_id: payment.id, payload: evento });
    if (dupErro) {
      if (dupErro.code === '23505') return res.status(200).json({ ok: true, duplicado: true });
      throw dupErro;
    }

    // ---- localizar o pedido ----
    // No Pix a cobrança é criada por nós e carrega o externalReference.
    // No cartão quem cria é o checkout hospedado, e a cobrança nasce sem ele —
    // aí o vínculo é pelo id da sessão de checkout, que guardamos no pedido.
    let pedido = null;

    if (payment.externalReference) {
      const { data } = await db.from('pedidos')
        .select('*').eq('id', payment.externalReference).maybeSingle();
      pedido = data || null;
    }

    if (!pedido && payment.checkoutSession) {
      const { data } = await db.from('pedidos')
        .select('*').eq('asaas_checkout_id', payment.checkoutSession).maybeSingle();
      pedido = data || null;
      if (pedido) console.log('[webhook] pedido localizado pela sessao de checkout:', pedido.id);
    }

    if (!pedido) {
      console.warn('[webhook] pedido nao encontrado. externalReference=%s checkoutSession=%s',
        payment.externalReference, payment.checkoutSession);
      return res.status(200).json({ ok: true, ignorado: 'pedido nao localizado' });
    }

    const pedidoId = pedido.id;

    // ---- 3. eventos de pagamento ----
    if (PAGO.has(event)) {
      if (pedido.status === 'PAGO') return res.status(200).json({ ok: true, jaProcessado: true });

      // Reconfere o valor direto na API — nao confia so no payload recebido.
      const cobranca = await asaas.getPayment(payment.id);
      let pagoCentavos = Math.round(Number(cobranca.value) * 100);
      let observacao = null;

      // Cartao parcelado: cada parcela e uma cobranca propria e o webhook
      // dispara uma vez por parcela. O que vale comparar e a soma do plano.
      if (cobranca.installment) {
        const soma = await asaas.somarParcelas(cobranca.installment);
        if (soma != null) {
          pagoCentavos = soma;
        } else {
          // Nao conseguimos apurar. Nao seguramos a venda por isso: o valor do
          // checkout foi definido por nos e o comprador nao consegue alterar.
          pagoCentavos = pedido.total_centavos;
          observacao = `Parcelamento ${cobranca.installment}: soma nao verificada`;
          console.warn('[webhook] soma de parcelas indisponivel no pedido', pedidoId);
        }
      }

      // Tolerancia de 1 centavo: parcela quebrada arredonda.
      if (pagoCentavos + 1 < pedido.total_centavos) {
        await db.from('pedidos').update({
          status: 'DIVERGENCIA_VALOR',
          observacao: `Pago R$ ${(pagoCentavos / 100).toFixed(2)} vs esperado R$ ${(pedido.total_centavos / 100).toFixed(2)}`,
        }).eq('id', pedidoId);
        console.error('[webhook] DIVERGENCIA DE VALOR no pedido', pedidoId);
        return res.status(200).json({ ok: true, divergencia: true });
      }

      await db.from('pedidos').update({
        status: 'PAGO',
        pago_em: new Date().toISOString(),
        asaas_payment_id: payment.id,
        valor_pago_centavos: pagoCentavos,
        observacao,
      }).eq('id', pedidoId);

      // ---- 4. fan-out de conversao (server-side) ----
      const resultado = await dispararConversao({
        id: pedido.id,
        email: pedido.cliente_email,
        telefone: pedido.cliente_telefone,
        nome: pedido.cliente_nome,
        ip: pedido.ip,
        user_agent: pedido.user_agent,
        ga_client_id: pedido.ga_client_id,
        ga_session_id: pedido.ga_session_id,
        fbp: pedido.fbp,
        fbc: pedido.fbc,
        source_url: pedido.source_url,
        itens: pedido.itens,
        total_unidades: pedido.total_unidades,
        total_centavos: pedido.total_centavos,
        frete_centavos: pedido.frete_centavos,
      });

      await db.from('pedidos')
        .update({ tracking_enviado: resultado, tracking_enviado_em: new Date().toISOString() })
        .eq('id', pedidoId);

      // ---- 4b. cria o pedido de venda no Bling (NF-e/estoque/etiqueta) ----
      // Lê o pedido de novo pelo id: já está PAGO e com valor_pago gravado.
      // Nunca lança (erros viram bling_erro e o cron tenta de novo), então
      // não segura a resposta 200 do webhook.
      if (process.env.BLING_PEDIDO_AUTO !== 'false') {
        try {
          await criarPedidoNoBling(pedidoId);
        } catch (e) {
          console.error('[webhook] Bling pedido:', e.message);
        }
      }

      // Gancho extra pro pos-pagamento (e-mail, WhatsApp, ou Bling via n8n se você preferir).
      if (process.env.N8N_WEBHOOK_URL) {
        fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-origem': 'asaas-webhook' },
          body: JSON.stringify({ pedido_id: pedidoId, evento: event }),
        }).catch((e) => console.error('[webhook] n8n:', e.message));
      }

      return res.status(200).json({ ok: true, pedido: pedidoId, status: 'PAGO' });
    }

    // ---- 5. demais estados ----
    const mapa = {
      PAYMENT_OVERDUE: 'VENCIDO',
      PAYMENT_DELETED: 'CANCELADO',
      PAYMENT_REFUNDED: 'ESTORNADO',
      PAYMENT_PARTIALLY_REFUNDED: 'ESTORNADO_PARCIAL',
      PAYMENT_CHARGEBACK_REQUESTED: 'CHARGEBACK',
      PAYMENT_CHARGEBACK_DISPUTE: 'CHARGEBACK_DISPUTA',
    };
    if (mapa[event]) {
      await db.from('pedidos').update({ status: mapa[event] }).eq('id', pedidoId);
      if (DEVOLVIDO.has(event)) console.warn(`[webhook] ${event} no pedido ${pedidoId} — revisar estoque/NF-e.`);
    }

    return res.status(200).json({ ok: true, evento: event });

  } catch (err) {
    console.error('[webhook] erro:', err);
    // 500 faz o Asaas reenviar; a idempotencia acima protege contra duplicidade.
    return res.status(500).json({ erro: 'Falha ao processar evento.' });
  }
}
