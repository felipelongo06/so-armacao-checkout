/**
 * Cota um CEP no Melhor Envio com o token do vercel-env.txt e mostra o que a
 * loja ofereceria (Econômico / Expresso) e a lista completa por trás.
 *
 *   node scripts/cotar-melhor-envio.js 41820-021            # 1 armação
 *   node scripts/cotar-melhor-envio.js 69010-001 2          # 2 armações
 *
 * Serve pra validar o token antes do deploy e pra conferir a regra com CEPs reais.
 */
import { carregarEnv } from '../lib/carregar-env.js';
carregarEnv();

const { cotarMelhorEnvio, montarOpcoes, configFrete, volumeDoPedido } = await import('../lib/frete.js');

const cep = String(process.argv[2] || '').replace(/\D/g, '');
const unidades = Number(process.argv[3] || 1);
if (cep.length !== 8) {
  console.error('Uso: node scripts/cotar-melhor-envio.js <CEP> [unidades]');
  process.exit(1);
}

const cfg = configFrete();
if (!cfg.token) {
  console.error('MELHOR_ENVIO_TOKEN não está no vercel-env.txt / .env.');
  process.exit(1);
}
const reais = (c) => (c / 100).toFixed(2).replace('.', ',');

console.log(`\nMelhor Envio (${cfg.url.includes('sandbox') ? 'SANDBOX' : 'PRODUÇÃO'}) — ${cfg.cepOrigem} → ${cep}, ${unidades} armação(ões)`);
console.log('Volume:', volumeDoPedido(unidades, cfg), `seguro R$ ${reais(cfg.seguroCentavos)}`);
console.log('Transportadoras aceitas:', cfg.transportadoras ? cfg.transportadoras.join(', ') : 'todas');

const inicio = Date.now();
const servicos = await cotarMelhorEnvio({ cepDestino: cep, unidades }, cfg);
console.log(`\n${servicos.length} serviços em ${Date.now() - inicio} ms:\n`);
for (const s of servicos.slice().sort((a, b) => a.custo_centavos - b.custo_centavos)) {
  console.log(`  ${String(s.id).padStart(3)}  ${(s.transportadora + ' ' + s.servico).padEnd(34)} ${String(s.prazo_dias).padStart(2)} d.u.   R$ ${reais(s.custo_centavos).padStart(7)}`);
}

const o = montarOpcoes(servicos, cfg);
console.log('\nO que a loja mostra:');
for (const cod of ['ECONOMICO', 'EXPRESSO']) {
  const x = o[cod];
  if (!x) { console.log(`  ${cod.padEnd(9)} —`); continue; }
  console.log(`  ${x.titulo.padEnd(9)} ${x.prazo.padEnd(18)} R$ ${reais(x.preco_centavos).padStart(7)}   (custo R$ ${reais(x.custo_centavos)} — ${x.transportadora} ${x.servico}, margem R$ ${reais(x.preco_centavos - x.custo_centavos)})`);
}
console.log();
