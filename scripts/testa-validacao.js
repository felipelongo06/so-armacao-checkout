#!/usr/bin/env node
import { cpfValido, emailValido, telefoneValido, cepValido, compararSegredo, hashCpf, hashPII } from '../lib/validacao.js';
process.env.CPF_HASH_SALT = process.env.CPF_HASH_SALT || 'teste-salt';

let p = 0, f = 0;
const t = (n, fn) => { try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${n}`); p++; } catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${n} — ${e.message}`); f++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\nValidações\n');
t('CPF válido passa',            () => assert(cpfValido('529.982.247-25'), 'deveria passar'));
t('CPF inválido falha',          () => assert(!cpfValido('111.111.111-11'), 'repetido deveria falhar'));
t('CPF com DV errado falha',     () => assert(!cpfValido('529.982.247-26'), 'deveria falhar'));
t('CPF curto falha',             () => assert(!cpfValido('1234'), 'deveria falhar'));
t('E-mail válido passa',         () => assert(emailValido('a@b.com.br'), 'deveria passar'));
t('E-mail sem domínio falha',    () => assert(!emailValido('a@b'), 'deveria falhar'));
t('Celular 11 dígitos passa',    () => assert(telefoneValido('(11) 98888-7777'), 'deveria passar'));
t('Telefone curto falha',        () => assert(!telefoneValido('1198'), 'deveria falhar'));
t('CEP 8 dígitos passa',         () => assert(cepValido('09750-000'), 'deveria passar'));
t('Segredo igual compara true',  () => assert(compararSegredo('abc123', 'abc123'), 'deveria bater'));
t('Segredo diferente é false',   () => assert(!compararSegredo('abc123', 'abc124'), 'nao deveria bater'));
t('Segredo vazio é false',       () => assert(!compararSegredo('', ''), 'vazio deveria falhar'));
t('Tamanho diferente é false',   () => assert(!compararSegredo('abc', 'abcd'), 'deveria falhar'));
t('Hash de CPF é determinístico',() => assert(hashCpf('529.982.247-25') === hashCpf('52998224725'), 'deveria bater'));
t('Hash de CPF não é o CPF',     () => assert(!hashCpf('52998224725').includes('52998224725'), 'vazou CPF'));
t('Hash PII normaliza caixa',    () => assert(hashPII(' A@B.COM ') === hashPII('a@b.com'), 'deveria normalizar'));

console.log(`\n${p} passou / ${f} falhou\n`);
process.exit(f ? 1 : 0);
