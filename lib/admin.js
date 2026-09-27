/**
 * Autenticação dos endpoints administrativos (sync, autorização do Bling).
 *
 * Aceita o mesmo segredo do cron (CRON_SECRET) de duas formas:
 *   - Authorization: Bearer <CRON_SECRET>   (é o que a Vercel manda no cron)
 *   - ?chave=<CRON_SECRET>                  (pra abrir no navegador)
 */
import { compararSegredo } from './validacao.js';

export function chaveAdmin(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) return h.slice(7);
  const q = req.query?.chave;
  if (q) return String(q);
  return '';
}

export function exigirAdmin(req, res) {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || !compararSegredo(chaveAdmin(req), segredo)) {
    res.status(401).json({ erro: 'Nao autorizado.' });
    return false;
  }
  return true;
}

export function paginaHtml(res, titulo, corpoHtml, status = 200) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#06301B;background:#F4EFE2;margin:0;padding:32px}
main{max-width:640px;margin:0 auto;background:#fff;padding:28px 32px;border:2px solid #06301B}
h1{font-size:22px;margin:0 0 12px}code{background:#F4EFE2;padding:2px 6px}a{color:#0B6B3A;font-weight:700}
.ok{color:#0B6B3A}.erro{color:#B3261E}</style></head><body><main><h1>${titulo}</h1>${corpoHtml}</main></body></html>`);
}
