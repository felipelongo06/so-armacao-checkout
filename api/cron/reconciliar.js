/**
 * GET /api/cron/reconciliar  (Vercel Cron — diario)
 *
 * Transforma "enviado != atribuido" em rotina. Faz duas coisas:
 *
 *  1. RETRY: reprocessa pedidos PAGOS recentes cujo envio a Meta ou ao GA4
 *     falhou. Redispara SO o canal que falhou, com o mesmo id do pedido como
 *     event_id (Meta) / transaction_id (GA4) — as duas plataformas deduplicam,
 *     entao reenviar NAO duplica conversao, desde que dentro da janela de dedup.
 *     Por isso a janela padrao e curta (3 dias): reprocessar historico antigo
 *     passaria da janela e ai sim contaria a venda duas vezes.
 *
 *  2. COBERTURA: loga e devolve um resumo do periodo (quantos PAGOS, quantos
 *     aceitos e identificados por plataforma, receita) pra enxergar buraco de
 *     atribuicao cedo, antes de distorcer a leitura de CAC.
 *
 * Seguranca: exige Authorization: Bearer $CRON_SECRET. A Vercel injeta esse
 * header automaticamente nas execucoes de cron quando CRON_SECRET existe no
 * ambiente; sem o segredo, o endpoint recusa tudo (401).
 */
import { exigirSupabase } from '../../lib/supabase.js';
import { metaPurchase, ga4Purchase } from '../../lib/tracking.js';
import { compararSegredo } from '../../lib/validacao.js';
import { pendentesDeBling, criarPedidoNoBling } from '../../lib/bling-pedido.js';

const JANELA_DIAS = Number(process.env.RECON_JANELA_DIAS || 3);
const MAX_POR_EXECUCAO = Number(process.env.RECON_MAX || 8);
const CONCORRENCIA = 8;

// Mapeia a linha do banco pro formato que o tracking.js espera — mesmo
// mapeamento que o webhook-asaas usa ao chamar dispararConversao.
function pedidoParaTracking(row) {
  return {
    id: row.id,
    email: row.cliente_email,
    telefone: row.cliente_telefone,
    nome: row.cliente_nome,
    ip: row.ip,
    user_agent: row.user_agent,
    ga_client_id: row.ga_client_id,
    ga_session_id: row.ga_session_id,
    fbp: row.fbp,
    fbc: row.fbc,
    source_url: row.source_url,
    itens: row.itens,
    total_unidades: row.total_unidades,
    total_centavos: row.total_centavos,
    frete_centavos: row.frete_centavos,
  };
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export default async function handler(req, res) {
  // ---- auth ----
  const segredo = process.env.CRON_SECRET;
  if (!segredo || !compararSegredo(bearer(req), segredo)) {
    return res.status(401).json({ erro: 'Nao autorizado.' });
  }

  try {
    const db = exigirSupabase();
    const desde = new Date(Date.now() - JANELA_DIAS * 86400_000).toISOString();

    // Uma leitura so do periodo: serve pro retry E pra cobertura. No volume
    // atual (dezenas/dia) 500 sobra; ajuste se um dia crescer muito.
    const { data: recentes, error: e1 } = await db.from('pedidos')
      .select('*')
      .eq('status', 'PAGO')
      .gte('pago_em', desde)
      .order('pago_em', { ascending: true })
      .limit(500);
    if (e1) throw e1;

    // ---- 1. RETRY dos envios que falharam ----
    const falhos = (recentes || []).filter((r) => {
      const t = r.tracking_enviado;
      return !t || t.meta !== true || t.ga4 !== true;
    }).slice(0, MAX_POR_EXECUCAO);

    let corrigidos = 0;

    for (let i = 0; i < falhos.length; i += CONCORRENCIA) {
      const lote = falhos.slice(i, i + CONCORRENCIA);
      await Promise.all(lote.map(async (row) => {
        const p = pedidoParaTracking(row);
        const atual = row.tracking_enviado || {};

        // Redispara SO o canal que ainda nao entrou.
        const [meta, ga4] = await Promise.all([
          atual.meta === true ? true : metaPurchase(p),
          atual.ga4 === true ? true : ga4Purchase(p),
        ]);

        const novo = {
          meta,
          ga4,
          identidade_meta: Boolean(p.fbp || p.fbc),
          identidade_ga4: Boolean(p.ga_client_id),
        };

        if ((novo.meta !== atual.meta || novo.ga4 !== atual.ga4) && (novo.meta || novo.ga4)) {
          corrigidos++;
        }

        // Reflete no objeto em memoria pra cobertura abaixo sair ja atualizada.
        row.tracking_enviado = novo;

        await db.from('pedidos')
          .update({ tracking_enviado: novo, tracking_reconciliado_em: new Date().toISOString() })
          .eq('id', row.id);
      }));
    }

    // ---- 1b. RETRY dos pedidos que não subiram pro Bling ----
    // Pedido pago cujo POST /pedidos/vendas falhou no webhook (Bling fora,
    // token vencido, produto sem bling_id). Sem etiqueta, não sai da casa.
    let blingCriados = 0, blingFalhos = 0;
    if (process.env.BLING_PEDIDO_AUTO !== 'false') {
      try {
        const pend = await pendentesDeBling({ desde, limite: Number(process.env.RECON_BLING_MAX || 15) });
        for (const p of pend) {
          const r = await criarPedidoNoBling(p);
          if (r.ok && !r.jaExistia) blingCriados++;
          else if (!r.ok) blingFalhos++;
        }
      } catch (e) {
        console.error('[reconciliar] Bling:', e.message);
      }
    }

    // ---- 2. COBERTURA do periodo ----
    const ok = (r, k) => r.tracking_enviado?.[k] === true;
    const cobertura = {
      janela_dias: JANELA_DIAS,
      pedidos_pagos: recentes.length,
      meta_ok: recentes.filter((r) => ok(r, 'meta')).length,
      ga4_ok: recentes.filter((r) => ok(r, 'ga4')).length,
      meta_identificado: recentes.filter((r) => ok(r, 'identidade_meta')).length,
      ga4_identificado: recentes.filter((r) => ok(r, 'identidade_ga4')).length,
      receita_reais: Math.round(recentes.reduce((s, r) => s + (r.total_centavos || 0), 0)) / 100,
    };

    console.log('[reconciliar] corrigidos=%d avaliados=%d bling_criados=%d bling_falhos=%d cobertura=%o', corrigidos, falhos.length, blingCriados, blingFalhos, cobertura);
    return res.status(200).json({ ok: true, corrigidos, avaliados: falhos.length, bling: { criados: blingCriados, falhos: blingFalhos }, cobertura });

  } catch (err) {
    console.error('[reconciliar] erro:', err);
    return res.status(500).json({ erro: 'Falha na reconciliacao.' });
  }
}
