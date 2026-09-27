/**
 * AUTORIDADE DE PREÇO — server-side.
 *
 * Regra inegociavel: o navegador manda APENAS { sku, qty }.
 * Preço, desconto Leve 2/3 e frete sao calculados aqui. Nunca confie em
 * "value" vindo do cliente — senao qualquer pessoa compra por R$ 1,00.
 *
 * A tabela `produtos` (sincronizada do Bling) é a única fonte de preço e
 * estoque. Sem banco, sem venda: não existe mais catálogo de fallback, porque
 * vender a preço velho e sem conferir estoque é pior do que recusar o pedido.
 */

import { supabase } from './supabase.js';

// Descontos progressivos por unidades no pedido (UPT e a alavanca de margem).
// Regra comercial vigente: percentual aplicado sobre o SUBTOTAL do pedido
// quando o carrinho atinge a faixa. A loja mostra o que este cálculo devolve
// (via /api/cotar), então mudar aqui muda a tela junto.
export const FAIXAS_LEVE = [
  { minUnidades: 3, pct: Number(process.env.LEVE3_PCT ?? 50) },
  { minUnidades: 2, pct: Number(process.env.LEVE2_PCT ?? 30) },
];

export const MAX_UNIDADES_PEDIDO = 20;

export function regrasPublicas() {
  return {
    leve2_pct: FAIXAS_LEVE.find((f) => f.minUnidades === 2)?.pct ?? 0,
    leve3_pct: FAIXAS_LEVE.find((f) => f.minUnidades === 3)?.pct ?? 0,
    max_unidades: MAX_UNIDADES_PEDIDO,
    frete_gratis_acima_de_centavos: Number(process.env.FRETE_GRATIS_ACIMA_DE ?? 19990),
  };
}

export function centavosParaReais(c) {
  return Number((c / 100).toFixed(2));
}

export class ValidacaoError extends Error {
  constructor(message) { super(message); this.name = 'ValidacaoError'; }
}

export class CatalogoIndisponivelError extends Error {
  constructor(message = 'Catalogo indisponivel no momento.') { super(message); this.name = 'CatalogoIndisponivelError'; }
}

async function buscarProdutos(skus) {
  if (!supabase) throw new CatalogoIndisponivelError('Banco de produtos nao configurado.');
  const { data, error } = await supabase
    .from('produtos')
    .select('sku, nome, cor, codigo_pai, preco_centavos, estoque, ativo, eh_teste, imagem_url')
    .in('sku', skus);
  if (error) throw new CatalogoIndisponivelError(`Falha ao consultar produtos: ${error.message}`);
  return Object.fromEntries(
    (data || []).filter((p) => p.ativo).map((p) => [p.sku, {
      nome: p.cor ? `${p.nome} — ${p.cor}` : p.nome,
      codigo_pai: p.codigo_pai,
      preco: p.preco_centavos,
      estoque: Number(p.estoque) || 0,
      imagem: p.imagem_url || null,
      teste: p.eh_teste === true,
    }])
  );
}

/**
 * Frete por região (tabela provisória). Vai ser substituído pela cotação
 * dinâmica do Melhor Envio (Bling Envios) — quando isso acontecer, só este
 * ponto muda: a loja já pede a cotação ao servidor via /api/cotar.
 */
export function calcularFrete(cep, subtotalCentavos) {
  const uf2 = String(cep || '').replace(/\D/g, '').slice(0, 2);
  if (!uf2 || uf2.length < 2) throw new ValidacaoError('CEP invalido.');
  if (subtotalCentavos >= Number(process.env.FRETE_GRATIS_ACIMA_DE ?? 19990)) return 0;
  const n = Number(uf2);
  if (n >= 1 && n <= 19) return 1990; // SP
  if (n >= 20 && n <= 39) return 2490; // RJ/ES/MG
  if (n >= 40 && n <= 65) return 3490; // Nordeste
  if (n >= 66 && n <= 69) return 3990; // Norte
  if (n >= 70 && n <= 79) return 2990; // Centro-Oeste
  if (n >= 80 && n <= 99) return 2490; // Sul
  throw new ValidacaoError('CEP fora da área de entrega.');
}

export function prazoFrete(cep) {
  const n = Number(String(cep || '').replace(/\D/g, '').slice(0, 2));
  if (n >= 1 && n <= 9) return 'até 3 dias úteis';
  return 'até 5 dias úteis';
}

/**
 * Recalcula o carrinho inteiro a partir de { sku, qty }.
 * Retorna valores em centavos + o resumo que vai pro Asaas e pro banco.
 *
 * @param itensCliente  [{ sku, qty }]
 * @param cep           CEP do comprador. Pode ser vazio quando `opcoes.semFrete`
 *                      é true (cotação do carrinho antes do endereço).
 * @param opcoes.catalogo  injeção de catálogo pros testes (não usar em produção).
 * @param opcoes.semFrete  devolve frete_centavos = null em vez de calcular.
 */
export async function montarPedido(itensCliente, cep, opcoes = {}) {
  if (!Array.isArray(itensCliente) || itensCliente.length === 0) {
    throw new ValidacaoError('Carrinho vazio.');
  }

  // Consolida SKUs repetidos e valida quantidades.
  const pedidos = new Map();
  for (const item of itensCliente) {
    const sku = String(item?.sku || '').trim().toUpperCase();
    const qty = Number.parseInt(item?.qty, 10);
    if (!sku) throw new ValidacaoError('Item sem SKU.');
    if (!/^[A-Z0-9][A-Z0-9-]{0,63}$/.test(sku)) throw new ValidacaoError(`SKU invalido: ${sku}.`);
    if (!Number.isInteger(qty) || qty < 1) throw new ValidacaoError(`Quantidade invalida para ${sku}.`);
    pedidos.set(sku, (pedidos.get(sku) || 0) + qty);
  }

  const totalUnidades = [...pedidos.values()].reduce((a, b) => a + b, 0);
  if (totalUnidades > MAX_UNIDADES_PEDIDO) {
    throw new ValidacaoError(`Maximo de ${MAX_UNIDADES_PEDIDO} unidades por pedido.`);
  }

  const catalogo = opcoes.catalogo || await buscarProdutos([...pedidos.keys()]);

  const itens = [];
  let subtotal = 0;
  for (const [sku, qty] of pedidos) {
    const produto = catalogo[sku];
    if (!produto) throw new ValidacaoError(`Produto indisponivel: ${sku}.`);
    if (!(produto.preco > 0)) throw new ValidacaoError(`Produto sem preco: ${sku}.`);
    const estoque = Number(produto.estoque);
    if (Number.isFinite(estoque) && estoque < qty) {
      throw new ValidacaoError(estoque <= 0
        ? `${produto.nome} esgotou.`
        : `${produto.nome}: só ${estoque} em estoque.`);
    }
    const totalItem = produto.preco * qty;
    subtotal += totalItem;
    itens.push({
      sku, nome: produto.nome, qty,
      preco_unit_centavos: produto.preco, total_centavos: totalItem,
      codigo_pai: produto.codigo_pai || null, imagem: produto.imagem || null,
    });
  }

  const faixa = FAIXAS_LEVE.find((f) => totalUnidades >= f.minUnidades);
  const descontoPct = faixa ? faixa.pct : 0;
  const desconto = Math.round(subtotal * (descontoPct / 100));
  const frete = opcoes.semFrete ? null : calcularFrete(cep, subtotal - desconto);
  const total = subtotal - desconto + (frete || 0);

  if (total <= 0) throw new ValidacaoError('Total invalido.');

  return {
    itens,
    total_unidades: totalUnidades,
    subtotal_centavos: subtotal,
    desconto_pct: descontoPct,
    desconto_centavos: desconto,
    frete_centavos: frete,
    frete_prazo: frete == null ? null : prazoFrete(cep),
    total_centavos: total,
    total_reais: centavosParaReais(total),
    descricao: itens.map((i) => `${i.qty}x ${i.nome}`).join(', '),
  };
}

/** Versão sem centavos, pra devolver ao navegador. */
export function resumoPublico(p) {
  return {
    itens: p.itens.map((i) => ({
      sku: i.sku, nome: i.nome, qty: i.qty, imagem: i.imagem || null,
      preco: centavosParaReais(i.preco_unit_centavos), total: centavosParaReais(i.total_centavos),
    })),
    unidades: p.total_unidades,
    subtotal: centavosParaReais(p.subtotal_centavos),
    desconto_pct: p.desconto_pct,
    desconto: centavosParaReais(p.desconto_centavos),
    frete: p.frete_centavos == null ? null : centavosParaReais(p.frete_centavos),
    frete_prazo: p.frete_prazo || null,
    total: centavosParaReais(p.total_centavos),
  };
}
