/**
 * AUTORIDADE DE PREÇO — server-side.
 *
 * Regra inegociavel: o navegador manda APENAS { sku, qty }.
 * Preço, desconto do 2º óculos e frete sao calculados aqui. Nunca confie em
 * "value" vindo do cliente — senao qualquer pessoa compra por R$ 1,00.
 *
 * A tabela `produtos` (sincronizada do Bling) é a única fonte de preço e
 * estoque. Sem banco, sem venda: não existe mais catálogo de fallback, porque
 * vender a preço velho e sem conferir estoque é pior do que recusar o pedido.
 */

import { supabase } from './supabase.js';

// ÚNICO desconto da loja (regra comercial de 27/09/2026): comprando 2 óculos,
// o 2º sai com 30% de desconto. O percentual incide só sobre a 2ª unidade
// (a mais barata do par), nunca sobre o pedido inteiro, e não existe faixa
// "Leve 3". A cada par fecha um desconto: 3 unidades = 1 desconto, 4 = 2.
// A loja mostra o que este cálculo devolve (via /api/cotar), então mudar aqui
// muda a tela junto. LEVE3_PCT ficou na Vercel e é ignorada de propósito.
export const LEVE2_PCT = Number(process.env.LEVE2_PCT ?? 30);

export const MAX_UNIDADES_PEDIDO = 20;

/**
 * Desconto do 2º óculos em centavos. Recebe a lista de preços unitários
 * (uma entrada por unidade), ordena do mais caro pro mais barato e aplica o
 * percentual na 2ª, 4ª, 6ª... unidade — o mais barato de cada par.
 */
export function descontoSegundoOculos(precosUnitarios) {
  const precos = precosUnitarios.slice().sort((a, b) => b - a);
  let desconto = 0, unidades = 0;
  for (let i = 1; i < precos.length; i += 2) {
    desconto += Math.round(precos[i] * (LEVE2_PCT / 100));
    unidades++;
  }
  return { desconto, unidades };
}

export function regrasPublicas() {
  return {
    leve2_pct: LEVE2_PCT,
    // Como o desconto funciona, pra loja não precisar adivinhar:
    // só o 2º óculos (o mais barato do par) sai com leve2_pct% off.
    desconto: { pct: LEVE2_PCT, regra: 'segundo-oculos', a_cada_par: true },
    max_unidades: MAX_UNIDADES_PEDIDO,
    // Sem frete grátis por padrão (decisão de 27/09/2026): cliente sempre paga o frete.
    // Promoção específica: defina FRETE_GRATIS_PROMO_ACIMA_DE (em centavos) na Vercel.
    frete_gratis_acima_de_centavos: limiteFreteGratis() || null,
  };
}

export function limiteFreteGratis() {
  // Lê só FRETE_GRATIS_PROMO_ACIMA_DE: a variável antiga (FRETE_GRATIS_ACIMA_DE)
  // ficou na Vercel com 19990 e passou a ser ignorada de propósito.
  const v = Number(process.env.FRETE_GRATIS_PROMO_ACIMA_DE ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
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
  const limite = limiteFreteGratis();
  if (limite > 0 && subtotalCentavos >= limite) return 0;
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

  // 30% só no 2º óculos (o mais barato de cada par) — nunca sobre o pedido inteiro.
  const precosUnitarios = itens.flatMap((i) => Array(i.qty).fill(i.preco_unit_centavos));
  const { desconto, unidades: unidadesComDesconto } = descontoSegundoOculos(precosUnitarios);
  const descontoPct = unidadesComDesconto > 0 ? LEVE2_PCT : 0;
  const frete = opcoes.semFrete ? null : calcularFrete(cep, subtotal - desconto);
  const total = subtotal - desconto + (frete || 0);

  if (total <= 0) throw new ValidacaoError('Total invalido.');

  return {
    itens,
    total_unidades: totalUnidades,
    subtotal_centavos: subtotal,
    desconto_pct: descontoPct,
    desconto_centavos: desconto,
    unidades_com_desconto: unidadesComDesconto,
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
    unidades_com_desconto: p.unidades_com_desconto || 0,
    frete: p.frete_centavos == null ? null : centavosParaReais(p.frete_centavos),
    frete_prazo: p.frete_prazo || null,
    total: centavosParaReais(p.total_centavos),
  };
}
