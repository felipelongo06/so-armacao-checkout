/**
 * GET /api/bling/corrigir-descricoes?chave=<CRON_SECRET>[&somente=ver][&codigos=A,B][&cursor=N]
 *
 * Uma vez só (idempotente). As descrições cadastradas no Bling prometiam
 * "garantia de 1 ano e troca em até 30 dias" — política que não existe:
 * a Só Armação não dá garantia além do CDC e a troca grátis é de 7 dias úteis
 * (direito de arrependimento). Como o Bling alimenta a loja E o Google
 * Shopping, a frase precisa sumir na fonte, não só na tela.
 *
 * Percorre os pais ativos e, dentro de cada um, as variações; onde a frase
 * aparece (descricaoCurta ou descricaoComplementar), reescreve só esse campo
 * via PATCH no produto certo (pai ou variação). `somente=ver`
 * mostra o que mudaria sem gravar. Respeita o limite de 3 req/s; se estourar
 * o tempo da função, devolve `continuar`. Depois, rode /api/bling/sync.
 */
import { exigirAdmin } from '../../lib/admin.js';
import { bling, blingTodas, BlingError } from '../../lib/bling.js';
import { limparCodigo } from '../../lib/catalogo-sync.js';

const FRASE = /garantia de 1 ano|troca (grátis )?em até 30 dias/i;

/** Mesma limpeza que a loja faz na exibição — aqui vira definitiva. */
export function corrigirTexto(texto) {
  return String(texto || '')
    .replace(/compre com nota fiscal,?\s*garantia de 1 ano( contra defeito de fabricação)?\s*e\s*troca em até 30 dias\.?/gi, 'Compre com nota fiscal e troca grátis em até 7 dias úteis.')
    .replace(/,?\s*garantia de 1 ano( contra defeito de fabricação)?/gi, '')
    .replace(/,?\s*(e\s*)?troca (grátis )?em até 30 dias/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,])/g, '$1')
    .trim();
}

export default async function handler(req, res) {
  if (!exigirAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const t0 = Date.now();
  const limiteMs = Number(process.env.BLING_SYNC_ORCAMENTO_MS || 45_000);
  const estourou = () => Date.now() - t0 > limiteMs;
  const somenteVer = String(req.query?.somente || '') === 'ver';
  const cursor = Math.max(0, parseInt(req.query?.cursor || '0', 10) || 0);
  const filtro = String(req.query?.codigos || '').split(',').map(limparCodigo).filter(Boolean);

  try {
    // Lista ativa traz só os pais; as variações vêm dentro do detalhe do pai.
    let lista = (await blingTodas('/produtos', { tipo: 'P', criterio: 2 }))
      .filter((p) => p && p.id && !p.idProdutoPai && p.formato !== 'E')
      .sort((a, b) => a.id - b.id);
    if (filtro.length) {
      lista = lista.filter((p) => filtro.some((c) => limparCodigo(p.codigo || '') === c || limparCodigo(p.codigo || '').startsWith(c + '-')));
    }

    const corrigidos = [], semFrase = [], erros = [], amostra = [];
    let i = cursor;
    for (; i < lista.length; i++) {
      if (estourou()) break;
      const p = lista[i];
      // A listagem nem sempre traz a descrição completa: confirma no detalhe.
      let det;
      try { det = (await bling('GET', `/produtos/${p.id}`))?.data; }
      catch (e) { erros.push({ codigo: p.codigo, id: p.id, etapa: 'ler', erro: e.message }); continue; }
      if (!det) continue;

      // Pai primeiro, depois cada variação (cada uma é um produto próprio no Bling).
      const alvos = [det, ...(Array.isArray(det.variacoes) ? det.variacoes : [])].filter((x) => x && x.id);
      for (const alvo of alvos) {
        const body = {};
        for (const campo of ['descricaoCurta', 'descricaoComplementar']) {
          const atual = String(alvo[campo] || '');
          if (!FRASE.test(atual)) continue;
          const novo = corrigirTexto(atual);
          if (novo !== atual) body[campo] = novo;
        }
        if (!Object.keys(body).length) { semFrase.push(alvo.codigo || alvo.id); continue; }

        if (somenteVer) {
          if (amostra.length < 10) amostra.push({ codigo: alvo.codigo, id: alvo.id, ...body });
          corrigidos.push(alvo.codigo || alvo.id);
          continue;
        }

        // Bling limita a 3 req/s e derruba com 429 em rajada: espaça e insiste.
        let ok = false, ultimo = null;
        for (let tentativa = 0; tentativa < 4 && !ok; tentativa++) {
          try {
            await bling('PATCH', `/produtos/${alvo.id}`, { body });
            ok = true;
          } catch (e) {
            ultimo = e;
            if (!(e instanceof BlingError && e.status === 429) || estourou()) break;
            await new Promise((r) => setTimeout(r, 2500 * (tentativa + 1)));
          }
        }
        if (ok) corrigidos.push(alvo.codigo || alvo.id);
        else erros.push({ codigo: alvo.codigo, id: alvo.id, etapa: 'gravar', erro: ultimo?.message, detalhe: ultimo?.corpo || null });
        await new Promise((r) => setTimeout(r, 700));
      }
      if (erros.length >= 5) { i++; break; }
    }

    const concluido = i >= lista.length && erros.length < 5;
    const saida = { ok: erros.length === 0, modo: somenteVer ? 'ver' : 'gravar', pais: lista.length, ate: i, concluido,
      corrigidos: corrigidos.length, codigos_corrigidos: corrigidos, sem_frase: semFrase.length, erros, duracao_ms: Date.now() - t0 };
    if (somenteVer) saida.amostra = amostra;
    if (!concluido && erros.length < 5) {
      const proxima = new URL(`https://${req.headers.host}${req.url}`);
      proxima.searchParams.set('cursor', String(i));
      saida.continuar = proxima.toString();
    }
    return res.status(200).json(saida);
  } catch (e) {
    console.error('[bling/corrigir-descricoes]', e);
    return res.status(500).json({ ok: false, erro: e.message, detalhe: e.corpo || null });
  }
}
