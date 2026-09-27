/**
 * GET /api/catalogo            catálogo inteiro (só o que está ativo)
 * GET /api/catalogo?codigo=X   um produto (código do pai OU de uma variação)
 *
 * É o que a loja lê pra montar vitrine, filtros e página de produto. Dados
 * públicos, por isso CORS aberto e cache na borda da Vercel (60 s, servindo
 * versão antiga por até 10 min enquanto renova) — estoque e preço na hora da
 * compra são reconferidos pelo /api/checkout, então a borda pode atrasar.
 *
 * Nada de custo, fornecedor ou situação interna sai daqui.
 */
import { supabase } from '../lib/supabase.js';
import { regrasPublicas, centavosParaReais } from '../lib/catalogo.js';

const COLUNAS = [
  'sku', 'codigo_pai', 'nome', 'nome_variacao', 'cor', 'preco_centavos', 'estoque', 'formato',
  'genero', 'material', 'ocasiao', 'tom_pele', 'marca', 'descricao', 'imagem_url', 'imagens',
  'link_externo', 'largura_lente', 'ponte', 'haste', 'peso_gramas', 'ordem', 'criado_em', 'atualizado_em',
].join(', ');

const FACETAS = ['formato', 'genero', 'material', 'ocasiao', 'tom_pele'];

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function agrupar(linhas) {
  const porPai = new Map();
  for (const r of linhas) {
    const chave = r.codigo_pai || r.sku;
    if (!porPai.has(chave)) {
      porPai.set(chave, {
        codigo: chave,
        slug: slug(chave),
        nome: r.nome,
        formato: r.formato, genero: r.genero, material: r.material, ocasiao: r.ocasiao, tom_pele: r.tom_pele,
        marca: r.marca,
        descricao: r.descricao,
        medidas: {
          lente: r.largura_lente, ponte: r.ponte, haste: r.haste,
          frontal: r.largura_lente && r.ponte ? r.largura_lente * 2 + r.ponte : null,
        },
        peso_gramas: r.peso_gramas,
        url: `/p/${chave}/`,
        criado_em: r.criado_em,
        atualizado_em: r.atualizado_em,
        variacoes: [],
      });
    }
    const p = porPai.get(chave);
    p.variacoes.push({
      sku: r.sku,
      cor: r.cor,
      cor_slug: slug(r.cor || 'unica'),
      preco: centavosParaReais(r.preco_centavos),
      estoque: Number(r.estoque) || 0,
      imagem: r.imagem_url || null,
      imagens: Array.isArray(r.imagens) ? r.imagens : [],
      url: `/p/${r.sku}/`,
      ordem: r.ordem || 0,
    });
    if (r.atualizado_em > p.atualizado_em) p.atualizado_em = r.atualizado_em;
  }

  const produtos = [...porPai.values()].map((p) => {
    p.variacoes.sort((a, b) => a.ordem - b.ordem || a.sku.localeCompare(b.sku));
    const precos = p.variacoes.map((v) => v.preco);
    p.preco = Math.min(...precos);
    p.preco_max = Math.max(...precos);
    p.estoque_total = p.variacoes.reduce((s, v) => s + v.estoque, 0);
    p.imagem = (p.variacoes.find((v) => v.estoque > 0) || p.variacoes[0])?.imagem || null;
    p.cores = p.variacoes.map((v) => v.cor).filter(Boolean);
    return p;
  });

  // Com estoque primeiro; dentro do grupo, os mais novos no Bling.
  produtos.sort((a, b) => (b.estoque_total > 0) - (a.estoque_total > 0) || String(b.criado_em).localeCompare(String(a.criado_em)));
  return produtos;
}

function facetas(produtos) {
  const out = {};
  for (const f of FACETAS) {
    const cont = new Map();
    for (const p of produtos) if (p[f]) cont.set(p[f], (cont.get(p[f]) || 0) + 1);
    out[f] = [...cont.entries()].map(([valor, total]) => ({ valor, slug: slug(valor), total }))
      .sort((a, b) => a.valor.localeCompare(b.valor, 'pt-BR'));
  }
  const cores = new Map();
  for (const p of produtos) for (const v of p.variacoes) if (v.cor) cores.set(v.cor, (cores.get(v.cor) || 0) + 1);
  out.cor = [...cores.entries()].map(([valor, total]) => ({ valor, slug: slug(valor), total }))
    .sort((a, b) => b.total - a.total || a.valor.localeCompare(b.valor, 'pt-BR'));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ erro: 'Metodo nao permitido.' });

  if (!supabase) return res.status(503).json({ erro: 'Catalogo indisponivel.' });

  const codigo = req.query?.codigo ? String(req.query.codigo).trim().toUpperCase() : null;

  try {
    let q = supabase.from('produtos').select(COLUNAS).eq('ativo', true).not('bling_id', 'is', null);
    if (codigo) q = q.or(`codigo_pai.eq.${codigo},sku.eq.${codigo}`);
    const { data, error } = await q.order('codigo_pai').order('ordem').limit(2000);
    if (error) throw error;

    let linhas = data || [];
    // Pediu o código de uma variação? Devolve o pai inteiro (todas as cores).
    if (codigo && linhas.length && linhas.every((r) => r.codigo_pai !== codigo)) {
      const pai = linhas[0].codigo_pai;
      if (pai) {
        const r2 = await supabase.from('produtos').select(COLUNAS).eq('ativo', true).eq('codigo_pai', pai).order('ordem');
        linhas = r2.data || linhas;
      }
    }

    const produtos = agrupar(linhas);
    const atualizadoEm = linhas.reduce((m, r) => (r.atualizado_em > m ? r.atualizado_em : m), '') || null;

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (codigo) {
      if (!produtos.length) return res.status(404).json({ erro: 'Produto nao encontrado.' });
      return res.status(200).json({ produto: produtos[0], regras: regrasPublicas(), atualizado_em: atualizadoEm });
    }
    return res.status(200).json({
      atualizado_em: atualizadoEm,
      total_modelos: produtos.length,
      total_variacoes: linhas.length,
      regras: regrasPublicas(),
      facetas: facetas(produtos),
      produtos,
    });
  } catch (err) {
    console.error('[catalogo] erro:', err);
    return res.status(500).json({ erro: 'Falha ao carregar o catalogo.' });
  }
}
