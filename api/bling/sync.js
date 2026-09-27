/**
 * GET|POST /api/bling/sync
 *
 * Sincroniza o catálogo inteiro do Bling pra tabela `produtos`.
 *   - Cron da Vercel (diário) manda Authorization: Bearer $CRON_SECRET.
 *   - À mão: /api/bling/sync?chave=$CRON_SECRET
 *
 * Limite de tempo da função: se não couber numa chamada, a resposta traz
 * `concluido: false` e um `cursor`. Chame de novo com ?cursor=... (ou só
 * repita a URL: a resposta já traz `continuar` pronta).
 */
import { exigirAdmin } from '../../lib/admin.js';
import { sincronizarCatalogo } from '../../lib/catalogo-sync.js';
import { BlingError } from '../../lib/bling.js';

export default async function handler(req, res) {
  if (!exigirAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const origem = req.headers['x-vercel-cron'] ? 'cron' : 'manual';
  const cursor = req.query?.cursor ? String(req.query.cursor) : null;
  const orcamentoMs = Number(process.env.BLING_SYNC_ORCAMENTO_MS || 45_000);

  try {
    const r = await sincronizarCatalogo({ origem, cursor, orcamentoMs });
    if (!r.concluido) {
      const proxima = new URL(`https://${req.headers.host}${req.url}`);
      proxima.searchParams.set('cursor', r.cursor);
      r.continuar = proxima.toString();
    }
    console.log('[bling/sync] %s concluido=%s resumo=%o', origem, r.concluido, r.resumo);
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.error('[bling/sync] erro:', e);
    const status = e instanceof BlingError && e.status === 401 ? 401 : 500;
    return res.status(status).json({ ok: false, erro: e.message });
  }
}
