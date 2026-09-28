/**
 * Testes da regra de frete (Econômico / Expresso + margem) — rodam OFFLINE.
 * As cotações abaixo são as reais do Melhor Envio em 28/09/2026, saindo de
 * 09607-000 com 18x10x7 cm / 0,3 kg, pra fixar o comportamento esperado.
 *
 *   node scripts/testa-frete.js
 */
import { precoDeVenda, montarOpcoes, normalizarServicos, volumeDoPedido, textoPrazo, cotarFrete, configFrete } from '../lib/frete.js';
import { montarPedido, resumoPublico } from '../lib/catalogo.js';

// Configuração fixa pros testes (independe do que estiver na Vercel/env local).
delete process.env.MELHOR_ENVIO_TOKEN;
delete process.env.FRETE_GRATIS_PROMO_ACIMA_DE;
process.env.FRETE_ECONOMICO_ADICIONAL_CENTAVOS = '300';
process.env.FRETE_EXPRESSO_ADICIONAL_CENTAVOS = '1000';
process.env.FRETE_EXPRESSO_GANHO_MIN_DIAS = '2';
process.env.FRETE_EXPRESSO_TOLERANCIA_DIAS = '1';
process.env.FRETE_DIAS_PREPARO = '1';
process.env.FRETE_TRANSPORTADORAS = 'Correios,Jadlog,Loggi,JeT';

let passou = 0, falhou = 0;
async function t(nome, fn) {
  try { await fn(); passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  catch (e) { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${nome}\n      ${e.message}`); }
}
function eq(a, b, rotulo = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${rotulo} esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

// Resposta crua no formato do Melhor Envio (subconjunto dos campos).
const s = (id, name, company, price, dias, error) => ({ id, name, company: { name: company }, price: error ? undefined : String(price), delivery_time: dias, error });

const SP = [
  s(33, 'Standard', 'JeT', 11.87, 1), s(4, '.Com', 'Jadlog', 13.35, 5), s(2, 'SEDEX', 'Correios', 13.57, 1),
  s(27, '.Package Centralizado', 'Jadlog', 14.55, 3), s(9, 'Standard', 'Total Express', 15.67, 3), s(3, '.Package', 'Jadlog', 15.68, 6),
  s(32, 'Loggi Ponto', 'Loggi', 17.08, 3), s(31, 'Express', 'Loggi', 17.48, 1), s(12, 'e-commerce', 'Azul Cargo Express', 21.12, 2),
  s(1, 'PAC', 'Correios', null, null, 'Transportadora não atende este trecho.'),
];
const SALVADOR = [
  s(31, 'Express', 'Loggi', 17.07, 4), s(32, 'Loggi Ponto', 'Loggi', 17.22, 6), s(33, 'Standard', 'JeT', 17.69, 3),
  s(27, '.Package Centralizado', 'Jadlog', 18.46, 4), s(4, '.Com', 'Jadlog', 22.50, 4), s(3, '.Package', 'Jadlog', 24.23, 5),
  s(9, 'Standard', 'Total Express', 24.59, 4), s(1, 'PAC', 'Correios', 26.39, 6), s(34, 'Coleta', 'Loggi', 29.30, 6),
  s(12, 'e-commerce', 'Azul Cargo Express', 35.67, 2), s(22, 'éFácil', 'LATAM Cargo', 36.25, 1), s(16, 'Expresso', 'Azul Cargo Express', 45.48, 1),
  s(2, 'SEDEX', 'Correios', 50.11, 2), s(17, 'Mini Envios', 'Correios', null, null, 'Dimensões do objeto ultrapassam o limite da transportadora.'),
];
const MANAUS = [
  s(27, '.Package Centralizado', 'Jadlog', 24.98, 17), s(31, 'Express', 'Loggi', 29.46, 9), s(4, '.Com', 'Jadlog', 30.19, 14),
  s(33, 'Standard', 'JeT', 31.74, 12), s(3, '.Package', 'Jadlog', 32.92, 15), s(1, 'PAC', 'Correios', 34.75, 20),
  s(9, 'Standard', 'Total Express', 36.67, 5), s(22, 'éFácil', 'LATAM Cargo', 42.68, 5), s(32, 'Loggi Ponto', 'Loggi', 42.82, 11),
  s(12, 'e-commerce', 'Azul Cargo Express', 43.80, 3), s(16, 'Expresso', 'Azul Cargo Express', 66.12, 2), s(2, 'SEDEX', 'Correios', 74.35, 3),
];
const POA = [
  s(27, '.Package Centralizado', 'Jadlog', 15.76, 4), s(31, 'Express', 'Loggi', 15.78, 3), s(32, 'Loggi Ponto', 'Loggi', 15.87, 5),
  s(33, 'Standard', 'JeT', 18.10, 3), s(4, '.Com', 'Jadlog', 19.48, 6), s(22, 'éFácil', 'LATAM Cargo', 21.10, 2),
  s(12, 'e-commerce', 'Azul Cargo Express', 22.01, 2), s(1, 'PAC', 'Correios', 23.72, 5), s(2, 'SEDEX', 'Correios', 36.26, 1),
  s(16, 'Expresso', 'Azul Cargo Express', 37.56, 1),
];

console.log('\nRegra de frete — Econômico / Expresso\n');

await t('Preço de venda: custo + adicional, arredondado pra cima até ,90', () => {
  eq(precoDeVenda(1586, 300), 1890, '15,86+3');
  eq(precoDeVenda(2120, 1000), 3190, '21,20+10');
  eq(precoDeVenda(1590, 300), 1890, '15,90+3 (exato)');
  eq(precoDeVenda(1187, 300), 1490, '11,87+3');
  eq(precoDeVenda(1890, 0), 1890, 'já termina em 90');
  eq(precoDeVenda(1891, 0), 1990, '1 centavo acima sobe pro próximo');
  eq(precoDeVenda(0, 0), 0, 'zero fica zero');
});

await t('Volume do pedido: caixas empilham na altura, peso multiplica', () => {
  eq(volumeDoPedido(1), { height: 7, width: 10, length: 18, weight: 0.3 });
  eq(volumeDoPedido(3), { height: 21, width: 10, length: 18, weight: 0.9 });
});

await t('Normalização: descarta erro, filtra transportadoras, preço em centavos', () => {
  const n = normalizarServicos(SP);
  eq(n.some((x) => x.servico === 'PAC'), false, 'PAC com erro sai');
  eq(n.some((x) => x.transportadora === 'Total Express'), false, 'Total Express fora da lista');
  eq(n.some((x) => x.transportadora === 'Azul Cargo Express'), false, 'Azul fora da lista');
  eq(n.find((x) => x.id === 33).custo_centavos, 1187, 'JeT em centavos');
});

await t('Prazo mostrado soma o dia de preparo', () => {
  eq(textoPrazo(1), 'até 2 dias úteis');
  eq(textoPrazo(0), 'até 1 dia útil');
});

await t('SP capital: mais barato também é o mais rápido → só Econômico', () => {
  const o = montarOpcoes(normalizarServicos(SP));
  eq(o.ECONOMICO.servico, 'Standard'); eq(o.ECONOMICO.transportadora, 'JeT');
  eq(o.ECONOMICO.preco_centavos, 1490, 'R$ 11,87 + 3 → 14,90');
  eq(o.ECONOMICO.prazo, 'até 2 dias úteis');
  eq(o.EXPRESSO, null, 'sem Expresso');
});

await t('Salvador: Econômico Loggi 4 d.u.; Expresso = SEDEX 2 d.u. (Azul/LATAM fora da lista)', () => {
  const o = montarOpcoes(normalizarServicos(SALVADOR));
  eq([o.ECONOMICO.transportadora, o.ECONOMICO.servico, o.ECONOMICO.preco_centavos, o.ECONOMICO.prazo], ['Loggi', 'Express', 2090, 'até 5 dias úteis']);
  eq([o.EXPRESSO.transportadora, o.EXPRESSO.servico, o.EXPRESSO.preco_centavos, o.EXPRESSO.prazo], ['Correios', 'SEDEX', 6090, 'até 3 dias úteis']);
});

await t('Salvador com todas as transportadoras: Expresso vira Azul e-commerce (mais barato até 1 dia da mais rápida)', () => {
  const cfg = { ...configFrete(), transportadoras: null };
  const o = montarOpcoes(normalizarServicos(SALVADOR, cfg), cfg);
  eq([o.EXPRESSO.transportadora, o.EXPRESSO.servico, o.EXPRESSO.prazo_dias, o.EXPRESSO.preco_centavos], ['Azul Cargo Express', 'e-commerce', 2, 4590]);
});

await t('Manaus: Econômico Jadlog 17 d.u.; Expresso = SEDEX 3 d.u.', () => {
  const o = montarOpcoes(normalizarServicos(MANAUS));
  // 24,98 + 3,00 = 27,98 → sobe pro próximo ,90 = 28,90
  eq([o.ECONOMICO.servico, o.ECONOMICO.preco_centavos, o.ECONOMICO.prazo], ['.Package Centralizado', 2890, 'até 18 dias úteis']);
  eq([o.EXPRESSO.servico, o.EXPRESSO.preco_centavos, o.EXPRESSO.prazo], ['SEDEX', 8490, 'até 4 dias úteis']);
});

await t('Porto Alegre: Expresso precisa ganhar 2 dias — SEDEX 1 d.u. contra Jadlog 4 d.u.', () => {
  const o = montarOpcoes(normalizarServicos(POA));
  eq([o.ECONOMICO.servico, o.ECONOMICO.preco_centavos], ['.Package Centralizado', 1890]);
  eq([o.EXPRESSO.servico, o.EXPRESSO.preco_centavos, o.EXPRESSO.prazo_dias], ['SEDEX', 4690, 1]);
});

await t('Ganho mínimo maior que a diferença → Expresso some', () => {
  const cfg = { ...configFrete(), ganhoMinDias: 4 };
  const o = montarOpcoes(normalizarServicos(POA, cfg), cfg);
  eq(o.EXPRESSO, null);
});

await t('Expresso nunca sai mais barato que o Econômico', () => {
  // Serviço rápido e barato: vira o próprio Econômico; o "Expresso" não existe.
  const lista = normalizarServicos([s(33, 'Standard', 'JeT', 11.87, 1), s(1, 'PAC', 'Correios', 30.0, 8)]);
  const o = montarOpcoes(lista);
  eq(o.ECONOMICO.servico, 'Standard'); eq(o.EXPRESSO, null);
});

await t('cotarFrete com lista injetada: pede EXPRESSO onde não existe → volta ECONOMICO', async () => {
  const r = await cotarFrete({ cepDestino: '01310100', unidades: 1, opcao: 'EXPRESSO', servicos: normalizarServicos(SP) });
  eq(r.origem, 'melhor_envio'); eq(r.escolhida.codigo, 'ECONOMICO');
});

await t('cotarFrete sem token → null (chamador cai na tabela fixa)', async () => {
  const r = await cotarFrete({ cepDestino: '01310100', unidades: 1 });
  eq(r, null);
});

// ---- integração com o pedido (montarPedido) ----
const catalogo = {
  'LL307-PRETO': { nome: 'Armação LL307 — Preto', preco: 4900, estoque: 10, codigo_pai: 'LL307' },
};

await t('montarPedido com cotação: total usa o preço de venda da opção escolhida e grava o serviço', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1 }], '41820-021', { catalogo, frete: 'EXPRESSO', servicosFrete: normalizarServicos(SALVADOR) });
  eq(p.frete_centavos, 6090, 'frete'); eq(p.total_centavos, 4900 + 6090, 'total');
  eq(p.frete_opcao, 'EXPRESSO'); eq(p.frete_origem, 'melhor_envio');
  eq(p.frete_servico, { id: 2, nome: 'SEDEX', transportadora: 'Correios', custo_centavos: 5011, prazo_dias: 2 });
  const r = resumoPublico(p);
  eq(r.frete, 60.9); eq(r.frete_opcao, 'EXPRESSO'); eq(r.frete_titulo, 'Expresso');
  eq(r.frete_opcoes, [
    { codigo: 'ECONOMICO', titulo: 'Econômico', prazo: 'até 5 dias úteis', prazo_dias: 4, preco: 20.9 },
    { codigo: 'EXPRESSO', titulo: 'Expresso', prazo: 'até 3 dias úteis', prazo_dias: 2, preco: 60.9 },
  ]);
  eq(Object.keys(r.frete_opcoes[0]).includes('transportadora'), false, 'público não expõe transportadora');
});

await t('montarPedido sem Melhor Envio: tabela fixa vira opção única "Econômico"', async () => {
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1 }], '01310-100', { catalogo, frete: 'EXPRESSO' });
  eq(p.frete_centavos, 1990); eq(p.frete_origem, 'tabela'); eq(p.frete_opcao, 'ECONOMICO');
  eq(p.frete_prazo, 'até 3 dias úteis'); eq(p.frete_servico.nome, null);
  eq(resumoPublico(p).frete_opcoes, [{ codigo: 'ECONOMICO', titulo: 'Econômico', prazo: 'até 3 dias úteis', prazo_dias: null, preco: 19.9 }]);
});

await t('Frete grátis promocional zera só o Econômico', async () => {
  process.env.FRETE_GRATIS_PROMO_ACIMA_DE = '4000';
  const p = await montarPedido([{ sku: 'LL307-PRETO', qty: 1 }], '41820-021', { catalogo, frete: 'ECONOMICO', servicosFrete: normalizarServicos(SALVADOR) });
  eq(p.frete_centavos, 0); eq(p.frete_opcoes.EXPRESSO.preco_centavos, 6090);
  delete process.env.FRETE_GRATIS_PROMO_ACIMA_DE;
});

console.log(`\n${passou} passou / ${falhou} falhou\n`);
process.exit(falhou ? 1 : 0);
