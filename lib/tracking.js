/**
 * Fan-out server-side de conversao.
 *
 * Requisito do Felipe: o WEBHOOK DE PAGAMENTO e a fonte da verdade.
 * O Purchase so dispara quando o Asaas confirma — nunca no "obrigado" do front.
 * O front dispara begin_checkout/add_payment_info; o Purchase vem daqui, com
 * event_id compartilhado pra deduplicar com o pixel do navegador.
 */
import { hashPII } from './validacao.js';

const timeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

async function postJson(url, body, nome) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout(8000),
    });
    if (!res.ok) console.error(`[tracking] ${nome} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.ok;
  } catch (err) {
    console.error(`[tracking] ${nome} falhou:`, err.message);
    return false; // tracking nunca derruba o webhook
  }
}

/** Meta Conversions API — Purchase */
export async function metaPurchase(pedido) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return false;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: pedido.id,                 // dedup com o pixel do browser
      event_source_url: pedido.source_url || undefined,
      action_source: 'website',
      user_data: {
        em: [hashPII(pedido.email)].filter(Boolean),
        ph: [hashPII(`55${String(pedido.telefone || '').replace(/\D/g, '')}`)].filter(Boolean),
        fn: [hashPII(String(pedido.nome || '').split(' ')[0])].filter(Boolean),
        client_ip_address: pedido.ip || undefined,
        client_user_agent: pedido.user_agent || undefined,
        fbp: pedido.fbp || undefined,
        fbc: pedido.fbc || undefined,
      },
      custom_data: {
        currency: 'BRL',
        value: pedido.total_centavos / 100,
        content_type: 'product',
        num_items: pedido.total_unidades,
        order_id: pedido.id,
        contents: (pedido.itens || []).map((i) => ({
          id: i.sku, quantity: i.qty, item_price: i.preco_unit_centavos / 100,
        })),
      },
    }],
    ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}),
  };

  return postJson(
    `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
    payload, 'Meta CAPI'
  );
}

/** GA4 Measurement Protocol — purchase */
export async function ga4Purchase(pedido) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) return false;
  if (!pedido.ga_client_id) {
    console.warn('[tracking] GA4: pedido sem ga_client_id — evento sera atribuido como direct.');
  }

  const payload = {
    client_id: pedido.ga_client_id || `${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
    ...(pedido.ga_session_id ? { user_properties: {} } : {}),
    events: [{
      name: 'purchase',
      params: {
        transaction_id: pedido.id,
        currency: 'BRL',
        value: pedido.total_centavos / 100,
        shipping: (pedido.frete_centavos || 0) / 100,
        ...(pedido.ga_session_id ? { session_id: pedido.ga_session_id } : {}),
        engagement_time_msec: 1,
        items: (pedido.itens || []).map((i) => ({
          item_id: i.sku, item_name: i.nome, price: i.preco_unit_centavos / 100, quantity: i.qty,
        })),
      },
    }],
  };

  // GA4_DEBUG=true manda pro endpoint de validacao: o evento e conferido e
  // devolve os erros, mas NAO e gravado na propriedade. Use enquanto testa em
  // sandbox, pra nao injetar compra falsa nos dados de atribuicao.
  const debug = process.env.GA4_DEBUG === 'true';
  const caminho = debug ? '/debug/mp/collect' : '/mp/collect';
  const url = `https://www.google-analytics.com${caminho}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  if (!debug) return postJson(url, payload, 'GA4 MP');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: timeout(8000),
    });
    const r = await res.json().catch(() => ({}));
    const problemas = r?.validationMessages || [];
    if (problemas.length) {
      console.error('[tracking] GA4 DEBUG reprovou o evento:', JSON.stringify(problemas));
      return false;
    }
    console.log('[tracking] GA4 DEBUG: evento valido (nao gravado na propriedade)');
    return true;
  } catch (err) {
    console.error('[tracking] GA4 DEBUG falhou:', err.message);
    return false;
  }
}

/**
 * Google Ads — conversao offline via gclid.
 * Requer OAuth (refresh token) na Google Ads API. Deixado como no-op explicito:
 * na pratica o caminho mais barato e enviar o gclid pro GA4 acima e importar a
 * conversao do GA4 no Google Ads. Habilite so se precisar de upload direto.
 */
export async function googleAdsPurchase(pedido) {
  if (process.env.GOOGLE_ADS_ENABLED !== 'true') return false;
  console.warn('[tracking] Google Ads upload direto ainda nao implementado — use import via GA4.', pedido.id);
  return false;
}

/**
 * Dispara a conversao e devolve o que realmente aconteceu.
 *
 * "enviado" e "atribuido" sao coisas diferentes, e confundir as duas leva a
 * decisao de midia errada:
 *   meta / ga4                  -> a plataforma ACEITOU o evento
 *   identidade_meta / _ga4      -> o evento chegou IDENTIFICADO
 *
 * Sem identidade, o Meta faz correspondencia fraca (so e-mail e telefone) e o
 * GA4 registra a venda como trafego direto — receita aparece, origem nao.
 */
export async function dispararConversao(pedido) {
  const [meta, ga4] = await Promise.allSettled([
    metaPurchase(pedido), ga4Purchase(pedido), googleAdsPurchase(pedido),
  ]);

  return {
    meta: meta.status === 'fulfilled' && meta.value,
    ga4: ga4.status === 'fulfilled' && ga4.value,
    // fbp e o cookie do pixel no navegador; fbc guarda o clique do anuncio.
    identidade_meta: Boolean(pedido.fbp || pedido.fbc),
    // sem ga_client_id o GA4 nao consegue ligar a venda a sessao de origem.
    identidade_ga4: Boolean(pedido.ga_client_id),
  };
}
