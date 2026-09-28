/**
 * Sincronização Bling → Supabase (tabela `produtos`).
 *
 * Modelo: uma linha por VARIAÇÃO (modelo + cor), que é a unidade que se vende
 * e que tem estoque. O produto pai do Bling entra denormalizado em cada linha
 * (nome, formato, gênero, material, ocasião, tom de pele, descrição).
 *
 * De onde vem cada coisa:
 *   formato            categoria do produto no Bling (Gatinho, Redondo...)
 *   gênero/material/
 *   ocasião/tom_pele   campos customizados do produto PAI (a API v3 não expõe
 *                      as tags do Bling — por isso os campos existem)
 *   cor                atributo "Cor:" da variação
 *   preço/estoque      da variação (saldo virtual = físico − reservado)
 *   imagens            URLs externas (jsDelivr/so-armacao-fotos) da variação
 *   medidas            "Lente 55mm · ponte 17mm · haste 140mm" da descrição
 *
 * A execução é limitada no tempo (função serverless): se o orçamento estourar,
 * devolve um cursor pra continuar de onde parou na próxima chamada.
 */
import { bling, blingTodas } from './bling.js';
import { exigirSupabase } from './supabase.js';
import { TAGS_POR_CODIGO } from '../db/tags-bling.js';

const CAMPOS = {
  genero: ['genero', 'gênero', 'sexo'],
  material: ['material'],
  ocasiao: ['ocasiao', 'ocasião', 'estilo'],
  tom_pele: ['tom de pele', 'tom_pele', 'tom-de-pele', 'pele'],
};

export function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function limparCodigo(c) {
  return String(c || '').replace(/[\s\t]+/g, '').toUpperCase();
}

export function extrairMedidas(texto) {
  const t = semAcento(texto);
  const lente = t.match(/lente\s*:?\s*(\d{2,3})\s*mm/);
  const ponte = t.match(/ponte\s*:?\s*(\d{1,3})\s*mm/);
  const haste = t.match(/haste\s*:?\s*(\d{2,3})\s*mm/);
  return {
    largura_lente: lente ? Number(lente[1]) : null,
    ponte: ponte ? Number(ponte[1]) : null,
    haste: haste ? Number(haste[1]) : null,
  };
}

/** "Cor:Tartaruga e Dourado;Tamanho:Único" → { cor: 'Tartaruga e Dourado', tamanho: 'Único' } */
export function atributosVariacao(nome) {
  const out = {};
  String(nome || '').split(';').forEach((par) => {
    const i = par.indexOf(':');
    if (i < 1) return;
    out[semAcento(par.slice(0, i))] = par.slice(i + 1).trim();
  });
  return out;
}

function urlsImagens(midia, imagemURL) {
  const externas = midia?.imagens?.externas?.map((x) => x?.link).filter(Boolean) || [];
  const urls = midia?.imagens?.imagensURL?.map((x) => x?.link).filter(Boolean) || [];
  const internas = midia?.imagens?.internas?.map((x) => x?.link).filter(Boolean) || [];
  const todas = [...externas, ...urls, ...internas];
  if (!todas.length && imagemURL) todas.push(imagemURL);
  return [...new Set(todas.map((u) => String(u).trim()).filter(Boolean))];
}

function centavos(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function inteiroOuNulo(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function valorCampo(campo) {
  const v = campo?.item ?? campo?.valor;
  return v == null ? '' : String(v).trim();
}

/** Lê os campos customizados de um produto do Bling usando o mapa id → nome. */
export function lerAtributos(camposCustomizados, mapaCampos) {
  const out = { genero: null, material: null, ocasiao: null, tom_pele: null };
  for (const c of camposCustomizados || []) {
    const nome = semAcento(mapaCampos[c.idCampoCustomizado] || '');
    const valor = valorCampo(c);
    if (!nome || !valor) continue;
    for (const [coluna, apelidos] of Object.entries(CAMPOS)) {
      if (apelidos.some((a) => semAcento(a) === nome)) out[coluna] = valor;
    }
  }
  return out;
}

/**
 * Transforma o detalhe de um produto do Bling (pai com variações, ou simples)
 * nas linhas da tabela `produtos`.
 */
export function mapearProduto(det, ctx) {
  const { categorias = {}, mapaCampos = {}, listaPorId = {}, agora } = ctx;
  const paiAtivo = det.situacao === 'A';
  const codigoPai = limparCodigo(det.codigo);
  const formato = categorias[det.categoria?.id] || null;
  // Campos customizados do Bling têm prioridade; enquanto a API não devolver
  // os valores, vale o que estava nas tags do export de 27/09 (db/tags-bling.js).
  const doBling = lerAtributos(det.camposCustomizados, mapaCampos);
  const dasTags = TAGS_POR_CODIGO[codigoPai] || {};
  const atributos = {
    genero: doBling.genero || dasTags.genero || null,
    material: doBling.material || dasTags.material || null,
    ocasiao: doBling.ocasiao || dasTags.ocasiao || null,
    tom_pele: doBling.tom_pele || dasTags.tom_pele || null,
  };
  const medidasPai = extrairMedidas(det.descricaoCurta || det.descricaoComplementar);
  const descricaoPai = String(det.descricaoCurta || det.descricaoComplementar || '').trim();
  const imagensPai = urlsImagens(det.midia, det.imagemURL);
  const custoPai = centavos(listaPorId[det.id]?.precoCusto ?? det.fornecedor?.precoCusto ?? 0) || null;

  const base = (item, extra) => {
    const lista = listaPorId[item.id] || {};
    const imagens = urlsImagens(item.midia, item.imagemURL);
    const medidas = extrairMedidas(item.descricaoCurta || item.descricaoComplementar);
    const preco = centavos(item.preco) || centavos(det.preco);
    const saldo = item.estoque?.saldoVirtualTotal ?? lista.estoque?.saldoVirtualTotal ?? det.estoque?.saldoVirtualTotal ?? 0;
    const atributosItem = lerAtributos(item.camposCustomizados, mapaCampos);
    return {
      sku: limparCodigo(item.codigo),
      bling_id: item.id,
      bling_id_pai: extra.bling_id_pai,
      codigo_pai: codigoPai,
      nome: String(det.nome || item.nome || '').trim(),
      nome_variacao: extra.nome_variacao,
      cor: extra.cor,
      preco_centavos: preco,
      custo_centavos: centavos(lista.precoCusto ?? item.fornecedor?.precoCusto ?? 0) || custoPai,
      estoque: Math.max(0, Math.floor(Number(saldo) || 0)),
      ativo: paiAtivo && item.situacao === 'A' && preco > 0,
      bling_situacao: `${det.situacao || '?'}/${item.situacao || '?'}`,
      formato,
      genero: atributosItem.genero || atributos.genero,
      material: atributosItem.material || atributos.material,
      ocasiao: atributosItem.ocasiao || atributos.ocasiao,
      tom_pele: atributosItem.tom_pele || atributos.tom_pele,
      marca: det.marca || item.marca || null,
      descricao: String(item.descricaoCurta || '').trim() || descricaoPai,
      imagem_url: imagens[0] || imagensPai[0] || null,
      imagens: imagens.length ? imagens : imagensPai,
      link_externo: item.linkExterno || det.linkExterno || null,
      largura_lente: medidas.largura_lente ?? medidasPai.largura_lente,
      ponte: medidas.ponte ?? medidasPai.ponte,
      haste: medidas.haste ?? medidasPai.haste,
      peso_gramas: inteiroOuNulo((Number(item.pesoLiquido || det.pesoLiquido) || 0) * 1000) || null,
      ordem: extra.ordem,
      eh_teste: false,
      sincronizado_em: agora,
      atualizado_em: agora,
    };
  };

  const variacoes = Array.isArray(det.variacoes) ? det.variacoes : [];
  if (variacoes.length) {
    return variacoes
      .filter((v) => v && v.id && v.codigo)
      .map((v, i) => {
        const attrs = atributosVariacao(v.variacao?.nome);
        return base(v, {
          bling_id_pai: det.id,
          nome_variacao: v.variacao?.nome || null,
          cor: attrs.cor || null,
          ordem: Number(v.variacao?.ordem ?? i) || i,
        });
      });
  }
  // Produto simples (sem grade): ele mesmo é a unidade vendável.
  if (!det.codigo) return [];
  return [base(det, { bling_id_pai: null, nome_variacao: null, cor: null, ordem: 0 })];
}

// ---------------------------------------------------------------------------
// Contexto compartilhado (categorias e campos customizados)
// ---------------------------------------------------------------------------

export async function carregarCategorias() {
  const lista = await blingTodas('/categorias/produtos');
  const mapa = {};
  for (const c of lista) if (c?.id) mapa[c.id] = String(c.descricao || '').trim();
  return mapa;
}

/** Última resposta crua de /campos-customizados/modulos (pra diagnóstico). */
export let ultimaListaModulos = null;

export async function localizarModuloProdutos() {
  const r = await bling('GET', '/campos-customizados/modulos');
  ultimaListaModulos = r;
  const modulos = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []);
  const texto = (m) => JSON.stringify(m || {});
  const alvo = modulos.find((m) => /produto/i.test(String(m.modulo || '')) && !/fornecedor/i.test(String(m.nome || '')))
    || modulos.find((m) => /produto/i.test(String(m.nome || '')))
    || modulos.find((m) => /produto/i.test(texto(m)) && !/fornecedor/i.test(texto(m)));
  return alvo?.id || null;
}

export async function carregarCamposCustomizados() {
  const idModulo = await localizarModuloProdutos();
  if (!idModulo) return { idModulo: null, mapa: {}, lista: [], modulos: ultimaListaModulos };
  const lista = await blingTodas(`/campos-customizados/modulos/${idModulo}`);
  const mapa = {};
  for (const c of lista) if (c?.id) mapa[c.id] = String(c.nome || '').trim();
  return { idModulo, mapa, lista };
}

async function carregarContexto() {
  const [categorias, campos] = await Promise.all([carregarCategorias(), carregarCamposCustomizados()]);
  return { categorias, mapaCampos: campos.mapa, campos };
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

async function gravarLinhas(linhas) {
  if (!linhas.length) return;
  const db = exigirSupabase();
  const { error } = await db.from('produtos').upsert(linhas, { onConflict: 'bling_id' });
  if (error) throw new Error(`Supabase upsert produtos: ${error.message}`);
}

async function registrarSync(origem, dados) {
  try {
    const db = exigirSupabase();
    await db.from('bling_sync').insert({ origem, ...dados });
  } catch (e) {
    console.error('[bling-sync] falha ao registrar log:', e.message);
  }
}

function codificarCursor(c) { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
function decodificarCursor(s) {
  try { return s ? JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')) : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Sync completo
// ---------------------------------------------------------------------------

/**
 * Sincroniza o catálogo inteiro. Devolve { concluido, cursor?, resumo }.
 * Chame de novo com o `cursor` até `concluido === true`.
 */
export async function sincronizarCatalogo({ origem = 'manual', cursor = null, orcamentoMs = 45_000 } = {}) {
  const t0 = Date.now();
  const estado = decodificarCursor(cursor) || { inicio: new Date().toISOString(), idx: 0 };
  const agora = new Date().toISOString();

  const ctx = { ...(await carregarContexto()), agora };

  // Lista ativa (criterio 2). Quem sumir dela é desativado ao fim da rodada.
  const lista = await blingTodas('/produtos', { tipo: 'P', criterio: 2 });
  const listaPorId = {};
  for (const p of lista) listaPorId[p.id] = p;
  ctx.listaPorId = listaPorId;

  const pais = lista
    .filter((p) => !p.idProdutoPai && p.formato !== 'E')
    .sort((a, b) => a.id - b.id);

  let processados = 0, linhas = 0;
  const erros = [];
  let i = estado.idx;

  for (; i < pais.length; i++) {
    if (Date.now() - t0 > orcamentoMs) break;
    const p = pais[i];
    try {
      const det = (await bling('GET', `/produtos/${p.id}`))?.data;
      if (!det) continue;
      const rows = mapearProduto(det, ctx);
      await gravarLinhas(rows);
      linhas += rows.length;
      processados++;
    } catch (e) {
      erros.push({ id: p.id, codigo: p.codigo, erro: e.message });
      if (erros.length > 10) break;
    }
  }

  const concluido = i >= pais.length;
  const resumo = {
    inicio_rodada: estado.inicio,
    pais_na_lista: pais.length,
    pais_processados_nesta_chamada: processados,
    linhas_gravadas_nesta_chamada: linhas,
    erros,
    campos_customizados: Object.values(ctx.mapaCampos),
    duracao_ms: Date.now() - t0,
  };

  if (concluido) {
    // Tudo que não foi tocado nesta rodada saiu do Bling (ou ficou inativo).
    const db = exigirSupabase();
    const { data: desativados, error } = await db.from('produtos')
      .update({ ativo: false, atualizado_em: agora })
      .not('bling_id', 'is', null)
      .eq('ativo', true)
      .or(`sincronizado_em.is.null,sincronizado_em.lt."${estado.inicio}"`)
      .select('sku');
    if (error) erros.push({ erro: `desativar ausentes: ${error.message}` });
    resumo.desativados = (desativados || []).map((d) => d.sku);

    const { count } = await db.from('produtos').select('sku', { count: 'exact', head: true }).eq('ativo', true);
    resumo.ativos_no_banco = count ?? null;

    await registrarSync(origem, { terminado_em: new Date().toISOString(), ok: erros.length === 0, resumo, erro: erros.length ? JSON.stringify(erros).slice(0, 2000) : null });
    return { concluido: true, resumo };
  }

  return { concluido: false, cursor: codificarCursor({ inicio: estado.inicio, idx: i }), resumo };
}

// ---------------------------------------------------------------------------
// Sync de um produto só (webhook)
// ---------------------------------------------------------------------------

export async function sincronizarProdutoBling(blingId, { origem = 'webhook' } = {}) {
  const agora = new Date().toISOString();
  const ctx = { ...(await carregarContexto()), agora, listaPorId: {} };
  const db = exigirSupabase();

  let det = (await bling('GET', `/produtos/${blingId}`))?.data;
  if (!det) return { linhas: 0 };

  // Variação? Sobe pro pai, que traz a grade inteira.
  let idPai = det.variacao?.produtoPai?.id || det.idProdutoPai || null;
  if (!idPai && !Array.isArray(det.variacoes)) {
    const { data } = await db.from('produtos').select('bling_id_pai').eq('bling_id', blingId).maybeSingle();
    idPai = data?.bling_id_pai || null;
  }
  if (idPai) det = (await bling('GET', `/produtos/${idPai}`))?.data || det;

  const rows = mapearProduto(det, ctx);
  await gravarLinhas(rows);

  // Variação removida da grade: desativa o que sobrou daquele pai.
  if (det.id && rows.length) {
    const vivos = rows.map((r) => r.bling_id);
    await db.from('produtos').update({ ativo: false, atualizado_em: agora })
      .eq('bling_id_pai', det.id).not('bling_id', 'in', `(${vivos.join(',')})`);
  }
  await registrarSync(origem, { terminado_em: new Date().toISOString(), ok: true, resumo: { bling_id: blingId, pai: det.id, linhas: rows.length } });
  return { linhas: rows.length, pai: det.id };
}

export async function desativarProdutoBling(blingId) {
  const db = exigirSupabase();
  const agora = new Date().toISOString();
  await db.from('produtos').update({ ativo: false, atualizado_em: agora }).or(`bling_id.eq.${blingId},bling_id_pai.eq.${blingId}`);
}

export async function atualizarEstoqueBling(blingId, saldoVirtual) {
  const db = exigirSupabase();
  const estoque = Math.max(0, Math.floor(Number(saldoVirtual) || 0));
  const { data, error } = await db.from('produtos')
    .update({ estoque, atualizado_em: new Date().toISOString() })
    .eq('bling_id', blingId)
    .select('sku');
  if (error) throw new Error(`Supabase estoque: ${error.message}`);
  return data?.length || 0;
}
