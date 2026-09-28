/**
 * Conecta o Melhor Envio UMA vez (OAuth) — roda no seu Mac, não na Vercel.
 *
 *   node scripts/melhor-envio-conectar.js
 *
 * Como funciona: sobe um servidorzinho local (localhost), abre a URL de
 * consentimento do Melhor Envio no seu navegador (já logado na conta da Só
 * Armação), você clica em "Autorizar", o Melhor Envio volta pro localhost com
 * o `code`, o script troca por access_token + refresh_token e grava no
 * Supabase. A partir daí o servidor renova sozinho — você não roda isto de novo.
 *
 * Pré-requisitos no vercel-env.txt (as chaves ficam com você, eu não as toco):
 *   MELHOR_ENVIO_CLIENT_ID, MELHOR_ENVIO_CLIENT_SECRET   (do app na Área Dev)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY              (já estão aí)
 * E no app do Melhor Envio, a URL de redirecionamento tem que ser EXATAMENTE
 * a que aparecer abaixo (padrão http://localhost:8790/callback).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { carregarEnv } from '../lib/carregar-env.js';
carregarEnv();

const { urlAutorizacao, concluirAutorizacao, redirectUri, baseUrl, escopo } = await import('../lib/melhor-envio.js');

const porta = Number(new URL(redirectUri()).port || 8790);
const state = crypto.randomBytes(12).toString('hex');

if (!process.env.MELHOR_ENVIO_CLIENT_ID || !process.env.MELHOR_ENVIO_CLIENT_SECRET) {
  console.error('\nFalta MELHOR_ENVIO_CLIENT_ID / MELHOR_ENVIO_CLIENT_SECRET no vercel-env.txt.');
  console.error('Pegue no Melhor Envio → Integrações → Área Dev → seu app.\n');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\nFalta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no vercel-env.txt.\n');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${porta}`);
  if (url.pathname !== new URL(redirectUri()).pathname) { res.writeHead(404).end('não é aqui'); return; }

  const erro = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const devolvido = url.searchParams.get('state');

  const pagina = (titulo, corpo) => `<!doctype html><meta charset="utf-8"><title>${titulo}</title>
<body style="font:16px/1.6 -apple-system,Arial,sans-serif;background:#F4EFE2;color:#06301B;max-width:560px;margin:40px auto;padding:0 20px">
<h1 style="color:#0B6B3A">${titulo}</h1>${corpo}<p>Pode fechar esta aba e voltar pro terminal.</p></body>`;

  if (erro) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(pagina('Melhor Envio recusou', `<p>${erro}: ${url.searchParams.get('error_description') || ''}</p>`));
    console.error('\n✗ Autorização recusada:', erro); server.close(); process.exit(1);
  }
  if (devolvido && devolvido !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(pagina('State não confere', '<p>Comece de novo.</p>'));
    console.error('\n✗ state divergente — recomece.'); server.close(); process.exit(1);
  }
  if (!code) { res.writeHead(400).end('sem code'); return; }

  try {
    const t = await concluirAutorizacao(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pagina('Melhor Envio conectado ✓',
      `<p>Tokens gravados no Supabase. Vencem em <strong>${new Date(t.expira_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</strong> e renovam sozinhos.</p>`));
    console.log(`\n✓ Conectado. access_token vence em ${new Date(t.expira_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (renova sozinho).`);
    console.log('  Teste agora:  node scripts/cotar-melhor-envio.js 41820-021\n');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(pagina('Falhou ao trocar o code', `<p>${e.message}</p>`));
    console.error('\n✗ Falha ao trocar o code por tokens:', e.message, '\n');
  } finally {
    server.close(); process.exit(0);
  }
});

server.listen(porta, () => {
  const url = urlAutorizacao(state);
  console.log(`\nMelhor Envio (${baseUrl().includes('sandbox') ? 'SANDBOX' : 'PRODUÇÃO'}) — conectando, escopo "${escopo()}".`);
  console.log(`Servidor local ouvindo em ${redirectUri()}`);
  console.log('\n1) No app do Melhor Envio (Área Dev), confirme que a URL de redirecionamento é exatamente:');
  console.log(`     ${redirectUri()}`);
  console.log('\n2) Abra esta URL no navegador logado na conta da Só Armação e clique em Autorizar:\n');
  console.log(`     ${url}\n`);
});
