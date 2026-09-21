#!/usr/bin/env node
/**
 * Conserta a ASAAS_API_KEY do vercel-env.txt quando a colagem entrou
 * duplicada ou com sujeira em volta.
 *
 *   node scripts/consertar-chave.js
 *
 * Recorta os pedaços plausíveis do valor atual, testa cada um contra a API
 * do Asaas e regrava o arquivo com o que autenticar. Nada é colado de novo
 * e a chave nunca é impressa.
 */
import fs from 'node:fs';
import { carregarEnv } from '../lib/carregar-env.js';

const ARQ = 'vercel-env.txt';
const MARCA = '$aact_';

if (!fs.existsSync(ARQ)) {
  console.error(`\n  ${ARQ} não encontrado. Rode de dentro da pasta do projeto.\n`);
  process.exit(1);
}

carregarEnv();
const bruto = process.env.ASAAS_API_KEY || '';
if (!bruto) {
  console.error('\n  ASAAS_API_KEY não está no arquivo.\n');
  process.exit(1);
}

console.log(`\nValor atual: ${bruto.length} caracteres.`);

// Todas as posições onde uma chave pode começar.
const inicios = [];
for (let i = bruto.indexOf(MARCA); i !== -1; i = bruto.indexOf(MARCA, i + 1)) {
  // $aach_ é a segunda metade da própria chave, não um novo começo.
  if (bruto.startsWith('$aact_', i)) inicios.push(i);
}

const candidatos = new Set();
for (let k = 0; k < inicios.length; k++) {
  const ini = inicios[k];
  candidatos.add(bruto.slice(ini));                       // daqui até o fim
  if (inicios[k + 1] !== undefined) {
    candidatos.add(bruto.slice(ini, inicios[k + 1]));     // até o próximo começo
  }
}
candidatos.add(bruto);

const lista = [...candidatos]
  .map((c) => c.trim().replace(/^['"]|['"]$/g, ''))
  .filter((c) => c.length > 40)
  .sort((a, b) => a.length - b.length);

console.log(`Testando ${lista.length} recorte(s) contra o Asaas...\n`);

const base = (process.env.ASAAS_ENV || 'sandbox').toLowerCase() === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://api-sandbox.asaas.com/v3';

let vencedora = null;
for (const chave of lista) {
  try {
    const res = await fetch(`${base}/myAccount`, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': process.env.ASAAS_USER_AGENT || 'SoArmacao-Checkout/1.0',
        access_token: chave,
      },
    });
    if (res.ok) {
      const conta = await res.json();
      console.log(`  \x1b[32m✓\x1b[0m ${chave.length} caracteres — autenticou como ${conta?.name || conta?.email || 'conta válida'}`);
      vencedora = chave;
      break;
    }
    console.log(`  \x1b[31m✗\x1b[0m ${chave.length} caracteres — recusada (HTTP ${res.status})`);
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${chave.length} caracteres — erro de rede: ${e.message}`);
  }
}

if (!vencedora) {
  console.error('\n  Nenhum recorte funcionou. Gere uma chave nova no painel do Asaas');
  console.error('  e cole no arquivo com nano, entre aspas simples.\n');
  process.exit(1);
}

// Regrava só a linha da chave, preservando o resto do arquivo.
fs.copyFileSync(ARQ, `${ARQ}.bak`);
const linhas = fs.readFileSync(ARQ, 'utf8').split(/\r?\n/);
let trocou = false;
const novas = linhas.map((l) => {
  if (/^\s*ASAAS_API_KEY\s*=/.test(l)) { trocou = true; return `ASAAS_API_KEY='${vencedora}'`; }
  return l;
});
if (!trocou) novas.push(`ASAAS_API_KEY='${vencedora}'`);
fs.writeFileSync(ARQ, novas.join('\n'), { mode: 0o600 });

console.log(`\n\x1b[32mArquivo corrigido.\x1b[0m Cópia do anterior em ${ARQ}.bak`);
console.log('\nAgora rode:\n\n    set -a; source vercel-env.txt; set +a; node scripts/smoke-test.js\n');
