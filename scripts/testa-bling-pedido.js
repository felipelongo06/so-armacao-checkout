/**
 * Testes do payload do pedido de venda no Bling — rodam OFFLINE
 * (montarPayloadPedido é pura; não chama Bling nem Supabase).
 *
 *   node scripts/testa-bling-pedido.js
 */
import { montarPayloadPedido } from '../lib/bling-pedido.js';

let passou = 0, falhou = 0;
function t(nome, fn) {
  try { fn(); passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  catch (e) { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${nome}\n      ${e.message}`); }
}
function eq(a, b, r = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${r} esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); }
function ok(cond, r = '') { if (!cond) throw new Error(r || 'esperado verdadeiro'); }

const pedidoBase = {
  id: 'SA-ABC-1234',
  metodo: 'PIX',
  asaas_payment_id: 'pay_123',
  pago_em: '2026-09-28',
  itens: [
    { sku: 'LL307-PRETO', nome: 'Armação LL307 — Preto', qty: 2, preco_unit_centavos: 4900, total_centavos: 9800 },
  ],
  total_unidades: 2,
  subtotal_centavos: 9800,
  desconto_pct: 30,
  desconto_centavos: 1470,
  frete_centavos: 6090,
  total_centavos: 14420,
  valor_pago_centavos: 14420,
  frete_opcao: 'EXPRESSO',
  frete_origem: 'melhor_envio',
  frete_servico: 'SEDEX',
  frete_transportadora: 'Correios',
  frete_custo_centavos: 5011,
  frete_prazo_dias: 2,
  frete_prazo: 'até 3 dias úteis',
  cliente_nome: 'Maria Silva',
  cliente_telefone: '11999998888',
  cliente_email: 'maria@ex.com',
  cliente_cep: '41820021',
  cliente_numero: '100',
  cliente_complemento: 'ap 2',
  cliente_endereco: 'Rua X',
  cliente_bairro: 'Centro',
  cliente_cidade: 'Salvador',
  cliente_uf: 'BA',
};

console.log('\nPayload do pedido de venda no Bling\n');

t('numeroLoja = id do pedido (idempotência/rastreio)', () => {
  const p = montarPayloadPedido(pedidoBase, 55, { 'LL307-PRETO': 999 });
  eq(p.numeroLoja, 'SA-ABC-1234');
  eq(p.contato.id, 55);
});

t('Item liga no produto do Bling pelo bling_id (baixa estoque)', () => {
  const p = montarPayloadPedido(pedidoBase, 55, { 'LL307-PRETO': 999 });
  eq(p.itens[0].produto, { id: 999 });
  eq(p.itens[0].codigo, 'LL307-PRETO');
  eq(p.itens[0].quantidade, 2);
  eq(p.itens[0].valor, 49);
});

t('Sem bling_id: item entra sem vínculo e avisa nas observações internas', () => {
  const p = montarPayloadPedido(pedidoBase, 55, {});
  ok(!('produto' in p.itens[0]), 'não deve ter produto');
  ok(/sem vínculo com produto do Bling/i.test(p.observacoesInternas), 'aviso ausente');
  ok(/LL307-PRETO/.test(p.observacoesInternas));
});

t('Desconto do 2º óculos vai no campo desconto (em reais)', () => {
  const p = montarPayloadPedido(pedidoBase, 55, {});
  eq(p.desconto, { valor: 14.7, unidade: 'REAL' });
});

t('Frete cobrado e endereço da etiqueta', () => {
  const p = montarPayloadPedido(pedidoBase, 55, {});
  eq(p.transporte.frete, 60.9);
  eq(p.transporte.fretePorConta, 0);
  eq(p.transporte.etiqueta.cep, '41820-021');
  eq(p.transporte.etiqueta.municipio, 'Salvador');
  eq(p.transporte.etiqueta.numero, '100');
  eq(p.transporte.prazoEntrega, 2);
  eq(p.transporte.pesoBruto, 0.6);
});

t('Serviço escolhido chega no volume e nas observações (expedição escolhe a etiqueta)', () => {
  const p = montarPayloadPedido(pedidoBase, 55, {});
  eq(p.transporte.volumes[0].servico, 'Correios SEDEX');
  ok(/FRETE EXPRESSO/.test(p.observacoes), 'observação sem opção');
  ok(/Correios SEDEX/.test(p.observacoes), 'observação sem serviço');
  ok(/custo cotado R\$ 50,11/.test(p.observacoes), 'sem custo');
  ok(/cobrado da cliente R\$ 60,90/.test(p.observacoes), 'sem cobrado');
});

t('Fallback pra tabela fixa: sem serviço, volume usa o rótulo Econômico', () => {
  const p = montarPayloadPedido({
    ...pedidoBase, frete_opcao: 'ECONOMICO', frete_origem: 'tabela',
    frete_servico: null, frete_transportadora: null, frete_custo_centavos: null, frete_prazo_dias: null,
    frete_centavos: 3490,
  }, 55, {});
  eq(p.transporte.volumes[0].servico, 'Econômico');
  ok(/tabela fixa/.test(p.observacoes), 'devia avisar tabela fixa');
  ok(!('prazoEntrega' in p.transporte), 'sem prazo quando não há');
});

t('Forma de pagamento só entra quando configurada (BLING_FORMA_PAGAMENTO_PIX_ID)', () => {
  delete process.env.BLING_FORMA_PAGAMENTO_PIX_ID;
  ok(!('parcelas' in montarPayloadPedido(pedidoBase, 55, {})), 'não devia ter parcelas sem env');
  process.env.BLING_FORMA_PAGAMENTO_PIX_ID = '77';
  const p = montarPayloadPedido(pedidoBase, 55, {});
  eq(p.parcelas[0].formaPagamento, { id: 77 });
  eq(p.parcelas[0].valor, 144.2);
  delete process.env.BLING_FORMA_PAGAMENTO_PIX_ID;
});

console.log(`\n${passou} passou / ${falhou} falhou\n`);
process.exit(falhou ? 1 : 0);
