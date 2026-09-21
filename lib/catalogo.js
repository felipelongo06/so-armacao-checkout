/**
 * AUTORIDADE DE PREÇO — server-side.
 *
 * Regra inegociavel: o navegador manda APENAS { sku, qty }.
 * Preço, desconto Leve 2/3 e frete sao calculados aqui. Nunca confie em
 * "value" vindo do cliente — senao qualquer pessoa compra por R$ 1,00.
 */

import { supabase } from './supabase.js';

// Fallback usado se o Supabase estiver indisponivel ou o SKU nao existir la.
// Mantenha em sincronia com a tabela `produtos`.
const CATALOGO_FALLBACK = {
  'SA-D1': { nome: 'Armação D1', preco: 8990 },
  'SA-D2': { nome: 'Armação D2', preco: 8990 },
  'SA-D3': { nome: 'Armação D3', preco: 9990 },
  'SA-R5': { nome: 'Armação R5', preco: 10990 },
  'SA-V4': { nome: 'Armação V4', preco: 12990 },
  'SA-V5': { nome: 'Armação V5', preco: 12990 },
};

// Descontos progressivos por unidades no pedido (UPT e a alavanca de margem).
// Espelha os tweaks leve2Pct / leve3Pct do front.
const FAIXAS_LEVE = [
  { minUnidades: 3, pct: Number(process.env.LEVE3_PCT ?? 50) },
  { minUnidades: 2, pct: Number(process.env.LEVE2_PCT ?? 30) },
];

const PRECO_MINIMO_CENTAVOS = 8990; // piso de R$ 89,90 da marca
const MAX_UNIDADES_PEDIDO = 20;

export function centavosParaReais(c) {
  return Number((c / 100).toFixed(2));
}

async function buscarProdutos(skus) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('produtos')
        .select('sku, nome, preco_centavos, ativo, eh_teste')
        .in('sku', skus);
      if (!error && data?.length) {
        return Object.fromEntries(
          data.filter((p) => p.ativo).map((p) => [p.sku, { nome: p.nome, preco: p.preco_centavos, teste: p.eh_teste === true }])
        );
      }
    } catch { /* cai no fallback */ }
  }
  return Object.fromEntries(skus.filter((s) => CATALOGO_FALLBACK[s]).map((s) => [s, CATALOGO_FALLBACK[s]]));
}

/** Frete por região. Substituir pela cotação real (Correios/transportadora) no lugar indicado. */
export function calcularFrete(cep, subtotalCentavos) {
  const uf2 = String(cep || '').replace(/\D/g, '').slice(0, 2);
  if (!uf2 || uf2.length < 2) throw new ValidacaoError('CEP invalido.');
  if (subtotalCentavos >= Number(process.env.FRETE_GRATIS_ACIMA_DE ?? 19990)) return 0;
  const n = Number(uf2);
  if (n >= 1 && n <= 19) return 1990;   // SP
  if (n >= 20 && n <= 39) return 2490;  // RJ/ES/MG
  if (n >= 40 && n <= 65) return 3490;  // Nordeste
  if (n >= 66 && n <= 69) return 3990;  // Norte
  if (n >= 70 && n <= 79) return 2990;  // Centro-Oeste
  if (n >= 80 && n <= 99) return 2490;  // Sul
  throw new ValidacaoError('CEP fora da área de entrega.');
}

export class ValidacaoError extends Error {
  constructor(message) { super(message); this.name = 'ValidacaoError'; }
}

/**
 * Recalcula o carrinho inteiro a partir de { sku, qty }.
 * Retorna valores em centavos + o resumo que vai pro Asaas e pro banco.
 */
export async function montarPedido(itensCliente, cep) {
  if (!Array.isArray(itensCliente) || itensCliente.length === 0) {
    throw new ValidacaoError('Carrinho vazio.');
  }

  // Consolida SKUs repetidos e valida quantidades.
  const pedidos = new Map();
  for (const item of itensCliente) {
    const sku = String(item?.sku || '').trim().toUpperCase();
    const qty = Number.parseInt(item?.qty, 10);
    if (!sku) throw new ValidacaoError('Item sem SKU.');
    if (!Number.isInteger(qty) || qty < 1) throw new ValidacaoError(`Quantidade invalida para ${sku}.`);
    pedidos.set(sku, (pedidos.get(sku) || 0) + qty);
  }

  const totalUnidades = [...pedidos.values()].reduce((a, b) => a + b, 0);
  if (totalUnidades > MAX_UNIDADES_PEDIDO) {
    throw new ValidacaoError(`Maximo de ${MAX_UNIDADES_PEDIDO} unidades por pedido.`);
  }

  const catalogo = await buscarProdutos([...pedidos.keys()]);

  const itens = [];
  let subtotal = 0;
  for (const [sku, qty] of pedidos) {
    const produto = catalogo[sku];
    if (!produto) throw new ValidacaoError(`Produto indisponivel: ${sku}.`);
    if (!produto.teste && produto.preco < PRECO_MINIMO_CENTAVOS) {
      throw new ValidacaoError(`Preço de ${sku} abaixo do piso da marca.`);
    }
    const totalItem = produto.preco * qty;
    subtotal += totalItem;
    itens.push({ sku, nome: produto.nome, qty, preco_unit_centavos: produto.preco, total_centavos: totalItem });
  }

  const faixa = FAIXAS_LEVE.find((f) => totalUnidades >= f.minUnidades);
  const descontoPct = faixa ? faixa.pct : 0;
  const desconto = Math.round(subtotal * (descontoPct / 100));
  const frete = calcularFrete(cep, subtotal - desconto);
  const total = subtotal - desconto + frete;

  if (total <= 0) throw new ValidacaoError('Total invalido.');

  return {
    itens,
    total_unidades: totalUnidades,
    subtotal_centavos: subtotal,
    desconto_pct: descontoPct,
    desconto_centavos: desconto,
    frete_centavos: frete,
    total_centavos: total,
    total_reais: centavosParaReais(total),
    descricao: itens.map((i) => `${i.qty}x ${i.nome}`).join(', '),
  };
}
