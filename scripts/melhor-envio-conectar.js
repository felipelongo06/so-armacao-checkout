/**
 * Conecta o Melhor Envio (OAuth) — imprime a URL de consentimento pra você abrir.
 *
 *   node scripts/melhor-envio-conectar.js
 *
 * Como funciona: o Melhor Envio exige redirect https, então quem recebe a
 * autorização é o SEU backend (rota /api/melhor-envio/callback, um rewrite pro
 * callback OAuth que já existe — sem função nova). Este script só monta a URL
 * de consentimento com um `state` assinado; você abre no navegador logado na
 * conta da Só Armação, clica em Autorizar, e o backend grava os tokens no
 * Supabase sozinho. Não precisa rodar de novo (o token renova automático).
 *
 * PRÉ-REQUISITO: o backend com este código já tem que estar no ar (deploy feito)
 * e com MELHOR_ENVIO_CLIENT_ID/SECRET + CRON_SECRET nas variáveis da Vercel.
 *
 * No vercel-env.txt local (pra este script montar a URL): MELHOR_ENVIO_CLIENT_ID
 * e CRON_SECRET. As chaves ficam com você — o assistente não as toca.
 */
import { carregarEnv } from '../lib/carregar-env.js';
carregarEnv();

const { urlAutorizacao, gerarState, redirectUri, baseUrl, escopo, melhorEnvioConectado } = await import('../lib/melhor-envio.js');

if (!process.env.MELHOR_ENVIO_CLIENT_ID) {
  console.error('\nFalta MELHOR_ENVIO_CLIENT_ID no vercel-env.txt (pegue no app da Área Dev).\n');
  process.exit(1);
}
if (!process.env.CRON_SECRET) {
  console.error('\nFalta CRON_SECRET no vercel-env.txt (é o mesmo segredo dos crons/admin).\n');
  process.exit(1);
}

if (await melhorEnvioConectado()) {
  console.log('\nMelhor Envio JÁ está conectado (há token no Supabase). Reconectar só se der erro de auth.');
  console.log('Pra testar:  node scripts/cotar-melhor-envio.js 41820-021\n');
}

const url = urlAutorizacao(gerarState());
console.log(`\nMelhor Envio (${baseUrl().includes('sandbox') ? 'SANDBOX' : 'PRODUÇÃO'}) — escopo "${escopo()}".`);
console.log('\n1) Confirme que a URL de redirecionamento do app (Área Dev) é EXATAMENTE:');
console.log(`     ${redirectUri()}`);
console.log('\n2) Abra esta URL no navegador logado na conta da Só Armação e clique em Autorizar:\n');
console.log(`     ${url}\n`);
console.log('3) A página do seu backend vai dizer "Melhor Envio conectado ✓". Depois:');
console.log('     node scripts/cotar-melhor-envio.js 41820-021\n');
