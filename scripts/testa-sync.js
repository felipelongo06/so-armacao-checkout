#!/usr/bin/env node
/** Testes do mapeamento Bling → produtos (offline, sem token). */
process.env.BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || 'teste';
process.env.BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || 'segredo-de-teste';

import crypto from 'node:crypto';
import { mapearProduto, extrairMedidas, atributosVariacao, lerAtributos, limparCodigo } from '../lib/catalogo-sync.js';
import { assinaturaWebhookValida, gerarState, stateValido } from '../lib/bling.js';

let passou = 0, falhou = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${nome}`); passou++; }
  catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${nome}\n      ${e.message}`); falhou++; }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };

const DETALHE_PAI = {
  id: 16709611625, nome: 'Óculos Monte Carlo Gatinho', codigo: 'MF7764\t', preco: 301, situacao: 'A', formato: 'V',
  descricaoCurta: 'Óculos Monte Carlo Gatinho da Só Armação — formato gatinho. Estrutura em metal. Lente 55mm · ponte 17mm · haste 140mm. Leve 2 e a segunda sai com 30% OFF.',
  marca: 'Só Armação', linkExterno: 'https://soarmacao.com.br/p/MF7764/', pesoLiquido: 0.035,
  categoria: { id: 14517582 },
  midia: { imagens: { externas: [{ link: 'https://cdn.jsdelivr.net/gh/felipelongo06/so-armacao-fotos@main/MF7764-TARTARUGA-E-DOURADO.jpg' }] } },
  camposCustomizados: [
    { idCampoCustomizado: 901, item: 'Feminino' },
    { idCampoCustomizado: 902, valor: 'Metal' },
    { idCampoCustomizado: 903, item: 'Festa' },
  ],
  variacoes: [
    {
      id: 16709611703, nome: 'Óculos Monte Carlo Gatinho Cor:Tartaruga e Dourado', codigo: 'MF7764-TARTARUGA-E-DOURADO', preco: 301, situacao: 'A',
      estoque: { saldoVirtualTotal: 10 }, linkExterno: 'https://soarmacao.com.br/p/MF7764-TARTARUGA-E-DOURADO/',
      midia: { imagens: { externas: [{ link: 'https://cdn.jsdelivr.net/gh/felipelongo06/so-armacao-fotos@main/MF7764-TARTARUGA-E-DOURADO.jpg' }] } },
      variacao: { nome: 'Cor:Tartaruga e Dourado', ordem: 1, produtoPai: { id: 16709611625 } },
    },
    {
      id: 16709611704, nome: 'Óculos Monte Carlo Gatinho Cor:Preto', codigo: 'MF7764-PRETO', preco: 0, situacao: 'I',
      estoque: { saldoVirtualTotal: 0 }, midia: { imagens: { externas: [] } },
      variacao: { nome: 'Cor:Preto', ordem: 2, produtoPai: { id: 16709611625 } },
    },
  ],
};

const CTX = {
  agora: '2026-09-27T20:00:00.000Z',
  categorias: { 14517582: 'Gatinho', 14517691: 'Redondo' },
  mapaCampos: { 901: 'Gênero', 902: 'Material', 903: 'Ocasião', 904: 'Tom de pele' },
  listaPorId: { 16709611703: { precoCusto: 43 }, 16709611625: { precoCusto: 43 } },
};

console.log('\nSync Bling → produtos\n');

await t('Medidas saem da descrição', () => {
  const m = extrairMedidas('Lente 55mm · ponte 17mm · haste 140mm.');
  eq(m.largura_lente, 55, 'lente'); eq(m.ponte, 17, 'ponte'); eq(m.haste, 140, 'haste');
  const v = extrairMedidas('sem medidas');
  eq(v.largura_lente, null, 'sem lente');
});

await t('Atributos da variação (Cor:...)', () => {
  eq(atributosVariacao('Cor:Tartaruga e Dourado').cor, 'Tartaruga e Dourado', 'cor');
  eq(atributosVariacao('Tamanho:G;Cor:Verde').cor, 'Verde', 'cor composta');
  eq(atributosVariacao('').cor, undefined, 'vazio');
});

await t('Campos customizados viram colunas (item ou valor, com ou sem acento)', () => {
  const a = lerAtributos(DETALHE_PAI.camposCustomizados, CTX.mapaCampos);
  eq(a.genero, 'Feminino', 'genero'); eq(a.material, 'Metal', 'material'); eq(a.ocasiao, 'Festa', 'ocasiao'); eq(a.tom_pele, null, 'tom');
});

await t('Código perde o tab do export e vai pra maiúsculas', () => {
  eq(limparCodigo('MF7764\t'), 'MF7764', 'tab'); eq(limparCodigo(' ll307-preto '), 'LL307-PRETO', 'caixa');
});

await t('Pai com variações → uma linha por variação, pai denormalizado', () => {
  const rows = mapearProduto(DETALHE_PAI, CTX);
  eq(rows.length, 2, 'linhas');
  const r = rows[0];
  eq(r.sku, 'MF7764-TARTARUGA-E-DOURADO', 'sku');
  eq(r.codigo_pai, 'MF7764', 'codigo_pai');
  eq(r.bling_id, 16709611703, 'bling_id');
  eq(r.bling_id_pai, 16709611625, 'bling_id_pai');
  eq(r.nome, 'Óculos Monte Carlo Gatinho', 'nome');
  eq(r.cor, 'Tartaruga e Dourado', 'cor');
  eq(r.preco_centavos, 30100, 'preco');
  eq(r.custo_centavos, 4300, 'custo');
  eq(r.estoque, 10, 'estoque');
  eq(r.ativo, true, 'ativo');
  eq(r.formato, 'Gatinho', 'formato');
  eq(r.genero, 'Feminino', 'genero');
  eq(r.material, 'Metal', 'material');
  eq(r.ocasiao, 'Festa', 'ocasiao');
  eq(r.largura_lente, 55, 'lente'); eq(r.ponte, 17, 'ponte'); eq(r.haste, 140, 'haste');
  eq(r.peso_gramas, 35, 'peso');
  eq(r.imagem_url, 'https://cdn.jsdelivr.net/gh/felipelongo06/so-armacao-fotos@main/MF7764-TARTARUGA-E-DOURADO.jpg', 'imagem');
  eq(r.link_externo, 'https://soarmacao.com.br/p/MF7764-TARTARUGA-E-DOURADO/', 'link');
  eq(r.sincronizado_em, CTX.agora, 'sincronizado_em');
});

await t('Variação inativa ou sem preço fica ativo=false e herda preço do pai', () => {
  const rows = mapearProduto(DETALHE_PAI, CTX);
  const r = rows[1];
  eq(r.sku, 'MF7764-PRETO', 'sku');
  eq(r.ativo, false, 'ativo');
  eq(r.preco_centavos, 30100, 'preco herdado');
  eq(r.imagem_url, rows[0].imagem_url, 'imagem herdada do pai');
});

await t('Pai inativo desativa todas as variações', () => {
  const rows = mapearProduto({ ...DETALHE_PAI, situacao: 'I' }, CTX);
  eq(rows.every((r) => r.ativo === false), true, 'todas inativas');
});

await t('Produto simples (sem grade) vira uma linha só, sem cor', () => {
  const simples = { ...DETALHE_PAI, formato: 'S', variacoes: [], estoque: { saldoVirtualTotal: 3 } };
  const rows = mapearProduto(simples, CTX);
  eq(rows.length, 1, 'linhas');
  eq(rows[0].sku, 'MF7764', 'sku');
  eq(rows[0].codigo_pai, 'MF7764', 'codigo_pai');
  eq(rows[0].cor, null, 'cor');
  eq(rows[0].estoque, 3, 'estoque');
  eq(rows[0].bling_id_pai, null, 'sem pai');
});

await t('Assinatura HMAC do webhook confere (e recusa alterado)', () => {
  const corpo = JSON.stringify({ eventId: 'x', event: 'produto.updated', data: { id: 1 } });
  const hex = crypto.createHmac('sha256', process.env.BLING_CLIENT_SECRET).update(corpo, 'utf8').digest('hex');
  eq(assinaturaWebhookValida(corpo, `sha256=${hex}`), true, 'valida');
  eq(assinaturaWebhookValida(corpo, hex), true, 'sem prefixo');
  eq(assinaturaWebhookValida(corpo + ' ', `sha256=${hex}`), false, 'corpo alterado');
  eq(assinaturaWebhookValida(corpo, ''), false, 'vazia');
});

await t('State do OAuth: gerado aqui passa, inventado não', () => {
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron-de-teste';
  const s = gerarState();
  eq(stateValido(s), true, 'valido');
  eq(stateValido(s.slice(0, -1) + 'x'), false, 'assinatura alterada');
  eq(stateValido('a.b'), false, 'formato');
});

console.log(`\n${passou} passou / ${falhou} falhou\n`);
process.exit(falhou ? 1 : 0);
