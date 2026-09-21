/**
 * GET /api/pedido/:id  — usado pelo polling da tela de Pix.
 * Devolve so o minimo necessario pro front; nunca dados sensiveis.
 */
import { supabase } from '../../lib/supabase.js';
import { asaas } from '../../lib/asaas.js';
import { aplicarCors, rateLimit, apenasMetodo } from '../../lib/http.js';
import { ipDoCliente } from '../../lib/validacao.js';

export default async function handler(req, res) {
  if (aplicarCors(req, res)) return;
  if (apenasMetodo(req, res, 'GET')) return;

  if (!rateLimit(`status:${ipDoCliente(req)}`, { max: 120, janelaMs: 60_000 })) {
    return res.status(429).json({ erro: 'Muitas consultas.' });
  }

  const { id } = req.query;
  if (!/^SA-[A-Z0-9]+-[A-Z0-9]{4}$/.test(String(id || ''))) {
    return res.status(400).json({ erro: 'Pedido invalido.' });
  }

  try {
    if (!supabase) return res.status(503).json({ erro: 'Indisponivel.' });

    const { data: pedido } = await supabase
      .from('pedidos')
      .select('id, status, total_centavos, total_unidades, asaas_payment_id, pago_em')
      .eq('id', id).maybeSingle();

    if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });

    // Rede de seguranca: se o webhook atrasou, confirma direto no Asaas.
    let status = pedido.status;
    if (status === 'AGUARDANDO_PAGAMENTO' && pedido.asaas_payment_id) {
      try {
        const cobranca = await asaas.getPayment(pedido.asaas_payment_id);
        if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(cobranca.status)) {
          status = 'PAGO_AGUARDANDO_CONFIRMACAO';
        }
      } catch { /* mantem o status do banco */ }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      pedido_id: pedido.id,
      status,
      pago: status === 'PAGO',
      total: pedido.total_centavos / 100,
      unidades: pedido.total_unidades,
      pago_em: pedido.pago_em,
    });
  } catch (err) {
    console.error('[status] erro:', err);
    return res.status(500).json({ erro: 'Falha ao consultar pedido.' });
  }
}
