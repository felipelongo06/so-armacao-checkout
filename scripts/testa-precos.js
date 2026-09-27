#!/usr/bin/env node
/** Testes da autoridade de preço — roda sem rede, sem Supabase, sem chave. */
import { montarPedido, resumoPublico, ValidacaoError } from '../lib/catalogo.js';

let passou = 0, falhou = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${nome}`); passou++; }
  catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${nome}\n      ${e.message}`); falhou++; }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${b}, veio ${a}`); };
const recusa = async (fn, m) => {
  try { await fn(); throw new Error(`${m}: deveria falhar`); }
  catch (e) { if (!(e instanceof ValidacaoError)) throw e; return e; }
};

// Catálogo de teste injetado: espelha o formato que buscarProdutos() devolve
// a partir da tabela `produtos` (sincronizada do Bling). Preços reais da loja.
const CAT = {
  'LL307-PRETO':                 { nome: 'Óculos Paris Redondo — Preto',            codigo_pai: 'LL307',  preco: 4900,  estoque: 10 },
  'LL307-CINZA-CRISTAL':         { nome: 'Óculos Paris Redondo — Cinza Cristal',    codigo_pai: 'LL307',  preco: 4900,  estoque: 0 },
  'R6058-PRETO-E-VERMELHO':      { nome: 'Óculos Everest Retangular — Preto e Vermelho', codigo_pai: 'R6058', preco: 15400, estoque: 10 },
  'MF7764-TARTARUGA-E-DOURADO':  { nome: 'Óculos Monte Carlo Gatinho — Tartaruga e Dourado', codigo_pai: 'MF7764', preco: 30100, estoque: 2 },
};
const o = { catalogo: CAT };

console.log('\nAutoridade de preço\n');

await t('1 unidade a R$ 49,00 + frete SP', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1 }], '09750-000', o);
  eq(p.subtotal_centavos, 4900, 'subtotal');
  eq(p.desconto_pct, 0, 'desconto');
  eq(p.frete_centavos, 1990, 'frete');
  eq(p.total_centavos, 6890, 'total');
  eq(p.frete_prazo, 'até 3 dias úteis', 'prazo');
});

await t('Leve 2 aplica 30% sobre o subtotal', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 2 }], '09750-000', o);
  eq(p.subtotal_centavos, 9800, 'subtotal');
  eq(p.desconto_pct, 30, 'desconto pct');
  eq(p.desconto_centavos, 2940, 'desconto');
  eq(p.total_centavos, 9800 - 2940 + 1990, 'total');
});

await t('Frete gratis acima do piso (pos-desconto)', async () => {
  const p = await montarPedido([{ sku: 'R6058-PRETO-E-VERMELHO', qty: 2 }], '09750-000', o);
  // 2 x 154,00 = 308,00 ; -30% = 215,60 -> acima de 199,90
  eq(p.desconto_pct, 30, 'desconto pct');
  eq(p.frete_centavos, 0, 'frete');
});

await t('Leve 3 aplica 50%', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 3 }], '01310-100', o);
  eq(p.desconto_pct, 50, 'desconto pct');
  eq(p.subtotal_centavos, 14700, 'subtotal');
  eq(p.desconto_centavos, 7350, 'desconto');
});

await t('SKUs diferentes somam unidades para a faixa', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1 }, { sku: 'R6058-PRETO-E-VERMELHO', qty: 1 }], '09750-000', o);
  eq(p.total_unidades, 2, 'unidades');
  eq(p.desconto_pct, 30, 'desconto pct');
});

await t('SKU repetido é consolidado (e maiúsculas não importam)', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1 }, { sku: 'll307-preto', qty: 1 }], '09750-000', o);
  eq(p.itens.length, 1, 'itens');
  eq(p.itens[0].qty, 2, 'qty');
});

await t('Preço enviado pelo cliente é ignorado', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1, preco: 1, value: 1, total: 1 }], '09750-000', o);
  eq(p.subtotal_centavos, 4900, 'subtotal');
});

await t('Sem estoque é recusado com a mensagem certa', async () => {
  const e = await recusa(() => montarPedido([{ sku: 'LL307-CINZA-CRISTAL', qty: 1 }], '09750-000', o), 'esgotado');
  if (!/esgotou/.test(e.message)) throw new Error(`mensagem inesperada: ${e.message}`);
});

await t('Quantidade acima do estoque é recusada', async () => {
  const e = await recusa(() => montarPedido([{ sku: 'MF7764-TARTARUGA-E-DOURADO', qty: 3 }], '09750-000', o), 'estoque');
  if (!/só 2 em estoque/.test(e.message)) throw new Error(`mensagem inesperada: ${e.message}`);
});

await t('Cotação sem CEP devolve frete null e total sem frete', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1 }], '', { ...o, semFrete: true });
  eq(p.frete_centavos, null, 'frete');
  eq(p.total_centavos, 4900, 'total');
  const r = resumoPublico(p);
  eq(r.frete, null, 'resumo.frete');
  eq(r.total, 49, 'resumo.total');
  eq(r.itens[0].preco, 49, 'resumo.itens.preco');
});

await t('SKU inexistente é recusado', async () => {
  await recusa(() => montarPedido([{ sku: 'HACK-1', qty: 1 }], '09750-000', o), 'sku');
});

await t('SKU com caractere estranho é recusado', async () => {
  await recusa(() => montarPedido([{ sku: 'LL307 PRETO;drop', qty: 1 }], '09750-000', o), 'sku');
});

await t('Quantidade negativa é recusada', async () => {
  await recusa(() => montarPedido([{ sku: 'LL307-PRETO', qty: -5 }], '09750-000', o), 'qty');
});

await t('Carrinho vazio é recusado', async () => {
  await recusa(() => montarPedido([], '09750-000', o), 'vazio');
});

await t('Acima de 20 unidades é recusado', async () => {
  await recusa(() => montarPedido([{ sku: 'LL307-PRETO', qty: 50 }], '09750-000', o), 'max');
});

await t('CEP inválido é recusado', async () => {
  await recusa(() => montarPedido([{ sku: 'LL307-PRETO', qty: 1 }], 'abc', o), 'cep');
});

console.log(`\n${passou} passou / ${falhou} falhou\n`);
process.exit(falhou ? 1 : 0);
