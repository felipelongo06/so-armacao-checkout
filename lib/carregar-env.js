/**
 * Carrega variáveis de um arquivo .env local (vercel-env.txt ou .env) para
 * process.env, sem sobrescrever o que já estiver definido.
 *
 * Existe pra você nunca precisar digitar uma chave de API na linha de comando —
 * lá ela fica no histórico do shell e visível pra outros processos.
 */
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATOS = ['vercel-env.txt', '.env.local', '.env'];

export function carregarEnv(dir = process.cwd()) {
  for (const nome of CANDIDATOS) {
    const arquivo = path.join(dir, nome);
    if (!fs.existsSync(arquivo)) continue;

    const linhas = fs.readFileSync(arquivo, 'utf8').split(/\r?\n/);
    for (const linha of linhas) {
      const limpa = linha.trim();
      if (!limpa || limpa.startsWith('#')) continue;

      const igual = limpa.indexOf('=');
      if (igual < 1) continue;

      const chave = limpa.slice(0, igual).trim();
      let valor = limpa.slice(igual + 1).trim();

      // Remove aspas envolventes — sem interpretar nada dentro delas.
      if ((valor.startsWith("'") && valor.endsWith("'")) ||
          (valor.startsWith('"') && valor.endsWith('"'))) {
        valor = valor.slice(1, -1);
      }

      if (!(chave in process.env)) process.env[chave] = valor;
    }
    return nome;
  }
  return null;
}
