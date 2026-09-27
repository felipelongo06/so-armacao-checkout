/**
 * GET /api/bling/auth?chave=<CRON_SECRET>
 *
 * Passo 1 da conexão com o Bling: redireciona pro consentimento OAuth.
 * Abra no navegador em que o Bling da Só Armação está logado. Depois de
 * "Autorizar", o Bling volta pro /api/bling/callback com o code.
 *
 * O `state` vai assinado com o CRON_SECRET, então o callback só aceita
 * autorizações iniciadas por aqui — ninguém consegue plugar outra conta Bling.
 */
import { exigirAdmin, paginaHtml } from '../../lib/admin.js';
import { urlAutorizacao, gerarState, redirectUri } from '../../lib/bling.js';

export default async function handler(req, res) {
  if (!exigirAdmin(req, res)) return;
  try {
    const url = urlAutorizacao(gerarState());
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: url });
    res.end();
  } catch (e) {
    paginaHtml(res, 'Bling — configuração incompleta',
      `<p class="erro">${e.message}</p><p>Confira <code>BLING_CLIENT_ID</code> e <code>BLING_CLIENT_SECRET</code> na Vercel. O app no developer.bling.com.br precisa ter a URL de redirecionamento <code>${redirectUri()}</code>.</p>`, 500);
  }
}
