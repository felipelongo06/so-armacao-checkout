/**
 * Cria (ou reprocessa) no Bling o pedido de venda de um pedido pago.
 *
 *   node scripts/bling-pedido.js SA-XXXX-YYYY          # cria um pedido específico
 *   node scripts/bling-pedido.js SA-XXXX-YYYY --ver    # só mostra o payload (dry-run, não chama o Bling)
 *   node scripts/bling-pedido.js --pendentes           # cria todos os pagos que ainda não subiram
 *   node scripts/bling-pedido.js SA-XXXX-YYYY --forcar  # ignora o limite de tentativas
 *
 * Usa o token do Bling e do Supabase que já estão no vercel-env.txt.
 */
import { carregarEnv } from '../lib/carregar-env.js';
carregarEnv();

const { criarPedidoNoBling, pendentesDeBling, montarPayloadPedido } = await import('../lib/bling-pedido.js');
const { exigirSupabase } = await import('../lib/supabase.js');

const args = process.argv.slice(2);
const ver = args.includes('--ver') || args.includes('--dry-run');
const forcar = args.includes('--forcar');
const id = args.find((a) => /^SA-/i.test(a));

if (forcar && id) {
  await exigirSupabase().from('pedidos').update({ bling_tentativas: 0 }).eq('id', id);
}

if (args.includes('--pendentes')) {
  const pend = await pendentesDeBling({ limite: 100 });
  console.log(`\n${pend.length} pedido(s) pago(s) sem pedido no Bling.\n`);
  let ok = 0;
  for (const p of pend) {
    const r = await criarPedidoNoBling(p);
    console.log(`  ${p.id}  ${r.ok ? (r.jaExistia ? 'já existia' : `criado (Bling id ${r.bling_pedido_id})`) : 'FALHOU: ' + (r.erro || r.motivo)}`);
    if (r.ok && !r.jaExistia) ok++;
  }
  console.log(`\n${ok} criado(s).\n`);
  process.exit(0);
}

if (!id) {
  console.error('Uso: node scripts/bling-pedido.js SA-XXXX-YYYY [--ver|--forcar]  |  --pendentes');
  process.exit(1);
}

const r = await criarPedidoNoBling(id, { dryRun: ver });
if (ver) {
  console.log('\nPayload que seria enviado ao Bling (POST /pedidos/vendas):\n');
  console.log(JSON.stringify(r.payload, null, 2));
} else {
  console.log(r.ok
    ? `\n✓ ${id} — ${r.jaExistia ? 'já estava no Bling' : `criado no Bling: id ${r.bling_pedido_id}${r.bling_pedido_numero ? ` (nº ${r.bling_pedido_numero})` : ''}`}\n`
    : `\n✗ ${id} — ${r.erro || r.motivo}\n`);
}
process.exit(r.ok ? 0 : 1);
