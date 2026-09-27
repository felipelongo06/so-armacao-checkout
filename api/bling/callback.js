/**
 * GET /api/bling/callback?code=...&state=...
 *
 * Passo 2 da conexão: o Bling volta pra cá com o `code` (vale 1 minuto).
 * Troca por access_token + refresh_token e grava em `bling_tokens`.
 *
 * Não exige a chave de admin — quem chega aqui é o redirecionamento do Bling —
 * mas exige o `state` assinado que o /auth gerou (vale 15 minutos).
 */
import { paginaHtml } from '../../lib/admin.js';
import { concluirAutorizacao, stateValido } from '../../lib/bling.js';

export default async function handler(req, res) {
  const { code, state, error, error_description: desc } = req.query || {};

  if (error) {
    return paginaHtml(res, 'Bling recusou a autorização', `<p class="erro">${error}: ${desc || ''}</p>`, 400);
  }
  if (!stateValido(state)) {
    return paginaHtml(res, 'Autorização inválida ou expirada',
      '<p class="erro">O <code>state</code> não confere. Comece de novo por <code>/api/bling/auth?chave=…</code>.</p>', 400);
  }
  if (!code) {
    return paginaHtml(res, 'Faltou o code', '<p class="erro">O Bling não mandou o <code>code</code>.</p>', 400);
  }

  try {
    const t = await concluirAutorizacao(String(code));
    const base = `https://${req.headers.host}`;
    return paginaHtml(res, 'Bling conectado ✓', `
      <p class="ok">Tokens gravados. O access_token expira em <strong>${new Date(t.expira_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</strong> e renova sozinho.</p>
      <p>Próximos passos (cole a sua chave de admin no lugar de <code>CHAVE</code>):</p>
      <ol>
        <li><strong>Uma vez só</strong> — cria os campos customizados e copia as tags:<br>
          <code>${base}/api/bling/migrar-tags?chave=CHAVE</code></li>
        <li><strong>Sincronizar o catálogo</strong> (repete enquanto devolver <code>concluido: false</code>):<br>
          <code>${base}/api/bling/sync?chave=CHAVE</code></li>
        <li>Conferir a loja: <code>${base}/api/catalogo</code></li>
      </ol>
      <p>Webhooks: no developer.bling.com.br, aba <em>Webhooks</em> do app, aponte <em>Produto</em> e <em>Estoque</em> para
      <code>${base}/api/bling/webhook</code>.</p>`);
  } catch (e) {
    console.error('[bling/callback]', e);
    return paginaHtml(res, 'Falha ao trocar o code por tokens', `<p class="erro">${e.message}</p><p>Se o code expirou (vale 1 minuto), comece de novo por <code>/api/bling/auth?chave=…</code>.</p>`, 500);
  }
}
