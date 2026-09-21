#!/usr/bin/env node
/**
 * Valida a conexão com o Asaas sem criar cobrança real.
 *
 *   node scripts/smoke-test.js
 *
 * Lê tudo do vercel-env.txt (ou .env) da pasta atual. NÃO passe a chave na
 * linha de comando: ela fica no histórico do shell, e o `$` do início é
 * interpretado pelo zsh como variável, chegando vazia.
 * A chave é usada mas nunca impressa.
 */
import { carregarEnv } from '../lib/carregar-env.js';
import { asaas, isSandbox } from '../lib/asaas.js';

const origem = carregarEnv();
console.log(origem ? `\nVariáveis lidas de ${origem}` : '\nNenhum vercel-env.txt encontrado — usando o ambiente.');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const ko = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

console.log(`\nAmbiente: ${isSandbox() ? 'SANDBOX' : 'PRODUÇÃO'}\n`);

if (!process.env.ASAAS_API_KEY) {
  ko('ASAAS_API_KEY não definida.');
  console.log('\n  Rode `bash scripts/configurar.sh` para gerar o vercel-env.txt,');
  console.log('  ou confira se a chave está preenchida nele.\n');
  process.exit(1);
}
if (process.env.ASAAS_API_KEY.length < 40) {
  ko('ASAAS_API_KEY parece truncada. No zsh, a chave PRECISA de aspas simples:');
  console.log("      ASAAS_API_KEY='$aact_hmlg_...'   <- com aspas");
  console.log('  Sem elas o shell trata o $ como variável e engole o valor.\n');
  process.exit(1);
}

let falhas = 0;

try {
  const contas = await asaas._request('GET', '/myAccount');
  ok(`Autenticação OK — conta: ${contas?.name || contas?.email || 'identificada'}`);
} catch (e) {
  ko(`Autenticação falhou: ${e.message}`); falhas++;
}

try {
  const chaves = await asaas._request('GET', '/pix/addressKeys');
  if (chaves?.data?.length) {
    ok(`Chave Pix registrada (${chaves.data.length}) — QR dinâmico com validade longa.`);
  } else {
    ko('Nenhuma chave Pix registrada — o QR vai expirar às 23:59 do mesmo dia. Cadastre uma chave no painel.');
    falhas++;
  }
} catch (e) {
  ko(`Não consegui listar chaves Pix: ${e.message}`); falhas++;
}

try {
  const hooks = await asaas._request('GET', '/webhooks');
  const pagto = hooks?.data?.filter((h) => h.enabled);
  if (pagto?.length) {
    pagto.forEach((h) => ok(`Webhook ativo: ${h.url}`));
  } else {
    ko('Nenhum webhook ativo. Sem webhook o pedido nunca é confirmado.');
    falhas++;
  }
} catch (e) {
  ko(`Não consegui listar webhooks: ${e.message}`); falhas++;
}

['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','CPF_HASH_SALT','ASAAS_WEBHOOK_TOKEN','SITE_URL','ALLOWED_ORIGINS']
  .forEach((v) => process.env[v] ? ok(`${v} definida`) : (ko(`${v} faltando`), falhas++));

console.log(falhas ? `\n\x1b[31m${falhas} pendência(s).\x1b[0m\n` : '\n\x1b[32mTudo pronto.\x1b[0m\n');
process.exit(falhas ? 1 : 0);
