#!/usr/bin/env node
import { carregarEnv } from '../lib/carregar-env.js';
import { asaas, isSandbox } from '../lib/asaas.js';

carregarEnv();
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const ko = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
console.log(`\nAmbiente: ${isSandbox() ? 'SANDBOX' : 'PRODUÇÃO'}\n`);

let falhas = 0;
const hooks = await asaas._request('GET', '/webhooks');
const ativos = (hooks?.data || []).filter((h) => h.enabled);
if (!ativos.length) { ko('Nenhum webhook ativo.'); process.exit(1); }

for (const h of ativos) {
  console.log(`  ${h.url}`);
  if (!/\/api\/webhook-asaas\/?$/.test(h.url)) {
    ko('    Nao termina em /api/webhook-asaas.'); falhas++; continue;
  }
  let status;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    status = (await fetch(h.url, { method: 'GET', signal: ctrl.signal })).status;
    clearTimeout(t);
  } catch (e) {
    ko(`    Inalcancavel (${e.name === 'AbortError' ? 'tempo esgotado' : e.message}).`); falhas++; continue;
  }
  if (status === 405) ok('    Responde 405 — no ar e recusando GET, como esperado.');
  else if (status === 404) {
    ko('    Responde 404. Nao existe funcao nesse endereco.');
    console.log('      Certo:  https://api.soarmacao.com.br/api/webhook-asaas');
    console.log('      Errado: https://soarmacao.com.br/api/webhook-asaas');
    falhas++;
  } else { ko(`    Responde ${status}; o esperado era 405.`); falhas++; }
}
console.log(falhas ? `\n\x1b[31m${falhas} problema(s).\x1b[0m\n` : '\n\x1b[32mWebhook conferido.\x1b[0m\n');
process.exit(falhas ? 1 : 0);
