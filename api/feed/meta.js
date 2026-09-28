/**
 * GET /api/feed/meta            feed de produtos pro catálogo do Meta (CSV)
 * GET /api/feed/meta?formato=google   mesmo feed no formato do Merchant Center (TSV)
 *
 * O Meta (Commerce Manager → Fontes de dados → Feed agendado) e o Google
 * Merchant Center buscam esta URL sozinhos, em horário programado. Uma linha
 * por variação vendável (SKU = `id`, igual ao content_id que o Pixel manda),
 * agrupadas pelo código do pai (`item_group_id`). Preço, estoque, fotos e
 * atributos vêm da tabela `produtos`, que o Bling alimenta (sync + webhooks) —
 * ou seja, o catálogo do anúncio é o mesmo da loja.
 *
 * Regras: sem custo/fornecedor; só ativos; esgotado vai como "out of stock"
 * (o Meta pausa o anúncio do item em vez de quebrar o feed).
 */
import { supabase } from '../../lib/supabase.js';
import { centavosParaReais } from '../../lib/catalogo.js';

const SITE = (process.env.SITE_URL || 'https://soarmacao.com.br').replace(/\/+$/, '');
const MARCA = 'Só Armação';
// Versão das fotos: acompanha FOTOS_VERSAO da loja (a CDN manda cache longo).
const FOTOS_VERSAO = process.env.FOTOS_VERSAO || '2';
const RE_FOTO_CDN = /^(.*\/so-armacao-fotos@[^/]+\/[^/]+?)\.(jpe?g|png|webp)$/i;
const RE_LENTE_SOL = /lente\s+(escura|marrom|fum[êe]|preta|cinza|verde|azul|degrad|espelhad|polarizad)/i;

// Taxonomia do Google (o Meta aceita o ID): 524 = Health & Beauty > Health Care >
// Vision Care > Eyeglasses; 178 = Apparel & Accessories > Clothing Accessories > Sunglasses.
const CATEGORIA = { grau: '524', sol: '178' };
const GENERO = { feminino: 'female', masculino: 'male', unissex: 'unisex' };

const COLUNAS = [
  'sku', 'codigo_pai', 'nome', 'nome_variacao', 'cor', 'preco_centavos', 'estoque', 'formato',
  'genero', 'material', 'ocasiao', 'tom_pele', 'marca', 'descricao', 'imagem_url', 'imagens',
  'largura_lente', 'ponte', 'haste', 'ordem',
].join(', ');

function tipoDaLinha(r) {
  if (/\bde sol\b/i.test(r.nome || '')) return 'sol';
  if (RE_LENTE_SOL.test(`${r.cor || ''} ${r.nome_variacao || ''}`)) return 'sol';
  return 'grau';
}

function fotos(r) {
  const principal = r.imagem_url || (Array.isArray(r.imagens) ? r.imagens[0] : null);
  if (!principal) return { principal: '', extras: [] };
  const m = principal.match(RE_FOTO_CDN);
  const v = (u) => (RE_FOTO_CDN.test(u) && !u.includes('?') ? `${u}?v=${FOTOS_VERSAO}` : u);
  const extras = m
    ? [`${m[1]}-detalhe.${m[2]}`, `${m[1]}-lateral.${m[2]}`]
    : (Array.isArray(r.imagens) ? r.imagens.slice(1) : []);
  return { principal: v(principal), extras: extras.map(v) };
}

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function limparTexto(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function linhaFeed(r) {
  const tipo = tipoDaLinha(r);
  const { principal, extras } = fotos(r);
  const cor = limparTexto(r.cor);
  const nome = limparTexto(r.nome);
  const titulo = (cor ? `${nome} — ${cor}` : nome).slice(0, 150);
  const medidas = [r.largura_lente && `lente ${r.largura_lente} mm`, r.ponte && `ponte ${r.ponte} mm`, r.haste && `haste ${r.haste} mm`].filter(Boolean).join(' · ');
  let descricao = limparTexto(r.descricao) || `${nome} da ${MARCA}.`;
  if (medidas && !/\d+\s*mm/i.test(descricao)) descricao += ` Medidas: ${medidas}.`;
  const ativo = Number(r.estoque) > 0;
  return {
    id: r.sku,
    title: titulo,
    description: descricao.slice(0, 5000),
    availability: ativo ? 'in stock' : 'out of stock',
    condition: 'new',
    price: `${centavosParaReais(r.preco_centavos).toFixed(2)} BRL`,
    link: `${SITE}/p/${encodeURIComponent(r.sku)}/`,
    image_link: principal,
    additional_image_link: extras.join(','),
    brand: r.marca || MARCA,
    item_group_id: r.codigo_pai || r.sku,
    color: cor,
    gender: GENERO[semAcento(r.genero)] || 'unisex',
    age_group: 'adult',
    material: limparTexto(r.material),
    google_product_category: CATEGORIA[tipo],
    product_type: `${tipo === 'sol' ? 'Óculos de sol' : 'Óculos de grau'}${r.formato ? ` > ${r.formato}` : ''}`,
    inventory: Math.max(0, Math.floor(Number(r.estoque) || 0)),
    custom_label_0: tipo,
    custom_label_1: limparTexto(r.ocasiao),
    custom_label_2: limparTexto(r.tom_pele),
    custom_label_3: limparTexto(r.formato),
  };
}

const CAMPOS_META = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'additional_image_link', 'brand', 'item_group_id', 'color', 'gender', 'age_group', 'material', 'google_product_category', 'product_type', 'inventory', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3'];
// Merchant Center: mesmos campos, sem `inventory` (lá é `quantity`, opcional) e sem custom_label_3 extra.
const CAMPOS_GOOGLE = CAMPOS_META.filter((c) => c !== 'inventory');

function csv(campos, linhas) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [campos.join(','), ...linhas.map((l) => campos.map((c) => esc(l[c])).join(','))].join('\r\n') + '\r\n';
}
function tsv(campos, linhas) {
  const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return [campos.join('\t'), ...linhas.map((l) => campos.map((c) => esc(l[c])).join('\t'))].join('\n') + '\n';
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ erro: 'Metodo nao permitido.' });
  if (!supabase) return res.status(503).json({ erro: 'Catalogo indisponivel.' });
  const formato = String(req.query?.formato || 'meta').toLowerCase();

  try {
    const { data, error } = await supabase.from('produtos').select(COLUNAS)
      .eq('ativo', true).not('bling_id', 'is', null).order('codigo_pai').order('ordem').limit(5000);
    if (error) throw error;
    const linhas = (data || []).map(linhaFeed).filter((l) => l.image_link && l.price);

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=900');
    res.setHeader('X-Total-Itens', String(linhas.length));
    if (formato === 'google') {
      res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="so-armacao-google.tsv"');
      return res.status(200).send(tsv(CAMPOS_GOOGLE, linhas));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="so-armacao-meta.csv"');
    return res.status(200).send(csv(CAMPOS_META, linhas));
  } catch (err) {
    console.error('[feed/meta] erro:', err);
    return res.status(500).json({ erro: 'Falha ao gerar o feed.' });
  }
}
