#!/usr/bin/env node
/** Testes da autoridade de preço — roda sem rede, sem Supabase, sem chave. */
import { montarPedido, ValidacaoError } from '../lib/catalogo.js';

let passou = 0, falhou = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${nome}`); passou++; }
  catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${nome}\n      ${e.message}`); falhou++; }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${b}, veio ${a}`); };

console.log('\nAutoridade de preço\n');

await t('1 unidade a R$ 89,90 + frete SP', async () => {
  const p = await montarPedido([{ sku: 'SA-D1', qty: 1 }], '09750-000');
  eq(p.subtotal_centavos, 8990, 'subtotal');
  eq(p.desconto_pct, 0, 'desconto');
  eq(p.frete_centavos, 1990, 'frete');
  eq(p.total_centavos, 10980, 'total');
});

await t('Leve 2 aplica 30% sobre o subtotal', async () => {
  const p = await montarPedido([{ sku: 'SA-D1', qty: 2 }], '09750-000');
  eq(p.subtotal_centavos, 17980, 'subtotal');
  eq(p.desconto_pct, 30, 'desconto pct');
  eq(p.desconto_centavos, 5394, 'desconto');
  // 17980 - 5394 = 12586: abaixo do piso de frete grátis (199,90), entao paga frete.
  eq(p.total_centavos, 14576, 'total');
});

await t('Frete gratis acima do piso (pos-desconto)', async () => {
  const p = await montarPedido([{ sku: 'SA-V4', qty: 2 }, { sku: 'SA-V5', qty: 2 }], '09750-000');
  // 4 x 129,90 = 519,60 ; -50% = 259,80 -> acima de 199,90
  eq(p.desconto_pct, 50, 'desconto pct');
  eq(p.frete_centavos, 0, 'frete');
});

await t('Leve 3 aplica 50%', async () => {
  const p = await montarPedido([{ sku: 'SA-V4', qty: 3 }], '01310-100');
  eq(p.desconto_pct, 50, 'desconto pct');
  eq(p.subtotal_centavos, 38970, 'subtotal');
  eq(p.desconto_centavos, 19485, 'desconto');
});

await t('SKUs diferentes somam unidades para a faixa', async () => {
  const p = await montarPedido([{ sku: 'SA-D1', qty: 1 }, { sku: 'SA-D2', qty: 1 }], '09750-000');
  eq(p.total_unidades, 2, 'unidades');
  eq(p.desconto_pct, 30, 'desconto pct');
});

await t('SKU repetido é consolidado', async () => {
  const p = await montarPedido([{ sku: 'SA-D1', qty: 1 }, { sku: 'sa-d1', qty: 1 }], '09750-000');
  eq(p.itens.length, 1, 'itens');
  eq(p.itens[0].qty, 2, 'qty');
});

await t('Preço enviado pelo cliente é ignorado', async () => {
  const p = await montarPedido([{ sku: 'SA-D1', qty: 1, preco: 1, value: 1, total: 1 }], '09750-000');
  eq(p.subtotal_centavos, 8990, 'subtotal');
});

await t('SKU inexistente é recusado', async () => {
  try { await montarPedido([{ sku: 'HACK-1', qty: 1 }], '09750-000'); throw new Error('deveria falhar'); }
  catch (e) { if (!(e instanceof ValidacaoError)) throw e; }
});

await t('Quantidade negativa é recusada', async () => {
  try { await montarPedido([{ sku: 'SA-D1', qty: -5 }], '09750-000'); throw new Error('deveria falhar'); }
  catch (e) { if (!(e instanceof ValidacaoError)) throw e; }
});

await t('Carrinho vazio é recusado', async () => {
  try { await montarPedido([], '09750-000'); throw new Error('deveria falhar'); }
  catch (e) { if (!(e instanceof ValidacaoError)) throw e; }
});

await t('Acima de 20 unidades é recusado', async () => {
  try { await montarPedido([{ sku: 'SA-D1', qty: 50 }], '09750-000'); throw new Error('deveria falhar'); }
  catch (e) { if (!(e instanceof ValidacaoError)) throw e; }
});

await t('CEP inválido é recusado', async () => {
  try { await montarPedido([{ sku: 'SA-D1', qty: 1 }], 'abc'); throw new Error('deveria falhar'); }
  catch (e) { if (!(e instanceof ValidacaoError)) throw e; }
});

console.log(`\n${passou} passou / ${falhou} falhou\n`);
process.exit(falhou ? 1 : 0);
