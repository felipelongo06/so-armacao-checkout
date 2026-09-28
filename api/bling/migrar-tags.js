/**
 * GET /api/bling/migrar-tags?chave=<CRON_SECRET>[&somente=criar|preencher][&cursor=N]
 *
 * Uma vez só. A API v3 do Bling não expõe as TAGS dos produtos, então os
 * filtros da loja (Gênero, Material, Ocasião, Tom de pele) vivem em CAMPOS
 * CUSTOMIZADOS do produto. Este endpoint:
 *
 *   1. Cria os 4 campos (tipo lista, com as opções) no módulo Produtos — se
 *      ainda não existirem (procura pelo nome).
 *   2. Preenche cada produto PAI com os valores que estavam nas tags no
 *      export de 27/09/2026 (db/tags-bling.js). Produto sem tag fica em branco.
 *
 * É idempotente: rodar de novo só reescreve os mesmos valores. Respeita o
 * limite de 3 req/s; se estourar o tempo da função, devolve `continuar`.
 * Depois dele, rode /api/bling/sync pra trazer tudo pro Supabase.
 */
import { exigirAdmin } from '../../lib/admin.js';
import { bling, BlingError } from '../../lib/bling.js';
import { carregarCamposCustomizados, semAcento, limparCodigo } from '../../lib/catalogo-sync.js';
import { OPCOES, TAGS_POR_CODIGO } from '../../db/tags-bling.js';

const NOMES = { genero: 'Gênero', material: 'Material', ocasiao: 'Ocasião', tom_pele: 'Tom de pele' };

async function tipoLista() {
  const r = await bling('GET', '/campos-customizados/tipos');
  const tipos = r?.data || [];
  const lista = tipos.find((t) => /lista|sele|opc|opç|combo/i.test(String(t.nome || '')));
  const texto = tipos.find((t) => /texto|string|alfanum/i.test(String(t.nome || '')));
  return { lista: lista || null, texto: texto || null, todos: tipos };
}

async function garantirCampos(orcamento) {
  const campos = await carregarCamposCustomizados();
  if (!campos.idModulo) throw new Error(`Modulo Produtos nao encontrado em /campos-customizados/modulos. Resposta do Bling: ${JSON.stringify(campos.modulos).slice(0, 800)}`);
  const tipos = await tipoLista();
  const porNome = {};
  for (const c of campos.lista) porNome[semAcento(c.nome)] = c;

  const resultado = { criados: [], existentes: [], tipos: tipos.todos.map((t) => t.nome), modulo: campos.idModulo };
  const ids = {};

  for (const [coluna, nome] of Object.entries(NOMES)) {
    const existente = porNome[semAcento(nome)];
    if (existente) { ids[coluna] = existente.id; resultado.existentes.push(nome); continue; }
    if (orcamento.estourou()) break;

    const opcoes = (OPCOES[coluna] || []).map((o) => ({ nome: o }));
    const tentativas = [];
    if (tipos.lista) tentativas.push({ tipoCampo: { id: tipos.lista.id }, opcoes });
    if (tipos.texto) tentativas.push({ tipoCampo: { id: tipos.texto.id } });

    let criado = null, ultimoErro = null;
    for (const t of tentativas) {
      try {
        const r = await bling('POST', '/campos-customizados', {
          body: { nome, situacao: 1, obrigatorio: false, placeholder: `Selecione ${nome.toLowerCase()}`, modulo: { id: campos.idModulo }, ...t },
        });
        criado = r?.data || r;
        break;
      } catch (e) {
        ultimoErro = e;
        if (!(e instanceof BlingError)) throw e;
      }
    }
    if (!criado) throw new Error(`Nao consegui criar o campo "${nome}": ${ultimoErro?.message || 'sem detalhe'}`);
    ids[coluna] = criado.id;
    resultado.criados.push({ nome, id: criado.id });
  }
  return { ids, resultado };
}

async function localizarIdsPorCodigo(codigos) {
  // O export traz o ID do Bling; mesmo assim confirma pelo código, que é o que
  // não muda. Busca em lotes de 20 códigos por chamada.
  const mapa = {};
  for (let i = 0; i < codigos.length; i += 20) {
    const lote = codigos.slice(i, i + 20);
    const r = await bling('GET', '/produtos', { query: { 'codigos[]': lote, limite: 100, criterio: 5 } });
    for (const p of r?.data || []) if (p?.codigo) mapa[limparCodigo(p.codigo)] = p.id;
  }
  return mapa;
}

export default async function handler(req, res) {
  if (!exigirAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const t0 = Date.now();
  const limiteMs = Number(process.env.BLING_SYNC_ORCAMENTO_MS || 45_000);
  const orcamento = { estourou: () => Date.now() - t0 > limiteMs };
  const somente = String(req.query?.somente || '');
  const cursor = Math.max(0, parseInt(req.query?.cursor || '0', 10) || 0);

  try {
    // Modo de teste: grava UM campo em UM produto com um formato de payload e
    // devolve o que o Bling passou a retornar. ?somente=teste&codigo=YF8636&fmt=1..4
    if (somente === 'teste') {
      const { ids } = await garantirCampos(orcamento);
      const codigo = limparCodigo(req.query?.codigo || Object.keys(TAGS_POR_CODIGO)[0]);
      const fmt = String(req.query?.fmt || '1');
      const tags = TAGS_POR_CODIGO[codigo] || {};
      const valor = tags.genero || 'Feminino';
      const definicao = (await bling('GET', `/campos-customizados/${ids.genero}`))?.data || null;
      const opcao = (definicao?.opcoes || []).find((o) => semAcento(o.nome) === semAcento(valor)) || null;
      const idsPorCodigo = await localizarIdsPorCodigo([codigo]);
      const idProduto = idsPorCodigo[codigo] || tags.bling_id;
      const antes = (await bling('GET', `/produtos/${idProduto}`))?.data;
      const campo = { idCampoCustomizado: ids.genero };
      if (fmt === '1') Object.assign(campo, { valor, item: valor });
      if (fmt === '2') Object.assign(campo, { item: valor });
      if (fmt === '3') Object.assign(campo, { valor });
      if (fmt === '4') Object.assign(campo, { valor, item: valor, idVinculo: opcao?.id });
      if (fmt === '5') Object.assign(campo, { valor: String(opcao?.id ?? valor), item: valor });
      let respostaPatch = null, erroPatch = null;
      try { respostaPatch = await bling('PATCH', `/produtos/${idProduto}`, { body: { camposCustomizados: [campo] } }); }
      catch (e) { erroPatch = { mensagem: e.message, corpo: e.corpo || null }; }
      const depois = (await bling('GET', `/produtos/${idProduto}`))?.data;
      return res.status(200).json({ ok: !erroPatch, etapa: 'teste', codigo, idProduto, fmt, payload: campo, definicao_campo: definicao,
        campos_antes: antes?.camposCustomizados ?? null, resposta_patch: respostaPatch, erro_patch: erroPatch, campos_depois: depois?.camposCustomizados ?? null });
    }

    const { ids, resultado } = await garantirCampos(orcamento);
    const faltando = Object.keys(NOMES).filter((k) => !ids[k]);
    if (faltando.length) return res.status(200).json({ ok: false, etapa: 'criar', faltando, ...resultado });
    if (somente === 'criar') return res.status(200).json({ ok: true, etapa: 'criar', campos: ids, ...resultado });

    const codigos = Object.keys(TAGS_POR_CODIGO);
    const idsPorCodigo = await localizarIdsPorCodigo(codigos);

    const preenchidos = [], erros = [], semValor = [];
    let i = cursor;
    for (; i < codigos.length; i++) {
      if (orcamento.estourou()) break;
      const codigo = codigos[i];
      const tags = TAGS_POR_CODIGO[codigo];
      const idProduto = idsPorCodigo[codigo] || tags.bling_id;
      const campos = Object.keys(NOMES)
        .filter((k) => tags[k])
        .map((k) => ({ idCampoCustomizado: ids[k], valor: tags[k], item: tags[k] }));
      if (!campos.length) { semValor.push(codigo); continue; }
      try {
        await bling('PATCH', `/produtos/${idProduto}`, { body: { camposCustomizados: campos } });
        preenchidos.push(codigo);
      } catch (e) {
        erros.push({ codigo, idProduto, erro: e.message, detalhe: e.corpo || null });
        if (erros.length >= 5) break; // provavelmente formato errado: para e mostra
      }
    }

    const concluido = i >= codigos.length && erros.length < 5;
    const saida = { ok: erros.length === 0, etapa: 'preencher', concluido, campos: ids, ...resultado,
      preenchidos: preenchidos.length, sem_valor: semValor, erros, duracao_ms: Date.now() - t0 };
    if (!concluido && erros.length < 5) {
      const proxima = new URL(`https://${req.headers.host}${req.url}`);
      proxima.searchParams.set('cursor', String(i));
      saida.continuar = proxima.toString();
    }
    return res.status(200).json(saida);
  } catch (e) {
    console.error('[bling/migrar-tags]', e);
    return res.status(500).json({ ok: false, erro: e.message, detalhe: e.corpo || null });
  }
}
