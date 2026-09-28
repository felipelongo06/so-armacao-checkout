/**
 * FRETE DINÂMICO — Melhor Envio + regra "Econômico / Expresso".
 *
 * O que este módulo faz, nesta ordem:
 *   1. Cota no Melhor Envio (a mesma API da calculadora do painel) todas as
 *      transportadoras pro CEP do comprador e pro volume do pedido.
 *   2. Escolhe DUAS opções pra loja mostrar, sem nome de transportadora:
 *        ECONOMICO = a etiqueta mais barata.
 *        EXPRESSO  = entre as que chegam pelo menos FRETE_EXPRESSO_GANHO_MIN_DIAS
 *                    dias antes da Econômica, a mais barata das mais rápidas
 *                    (tolerância de FRETE_EXPRESSO_TOLERANCIA_DIAS sobre a mais
 *                    rápida de todas, pra não pagar caro por 1 dia a menos).
 *   3. Aplica a margem: preço de venda = custo + adicional, arredondado pro
 *      próximo valor terminado em ,90 (15,86 + 3,00 → 18,90; 21,20 + 10,00 → 31,90).
 *   4. Se o Melhor Envio falhar (sem token, timeout, erro), cai na TABELA FIXA
 *      por região (lib/catalogo.js) como opção única — a loja nunca fica sem frete.
 *
 * O que a cliente vê é só "Econômico / Expresso", prazo e preço. Transportadora,
 * serviço, custo e origem ficam gravados no pedido, pro Bling e pra conferência.
 *
 * Variáveis de ambiente (todas opcionais, exceto o token pra cotação real):
 *   MELHOR_ENVIO_TOKEN                token da conta (Integrações → Área Dev → Tokens)
 *   MELHOR_ENVIO_AMBIENTE             "production" (padrão) | "sandbox"
 *   FRETE_CEP_ORIGEM                  CEP de postagem (padrão 09607000, o da conta)
 *   FRETE_ECONOMICO_ADICIONAL_CENTAVOS  margem sobre o custo (padrão 300 = R$ 3,00)
 *   FRETE_EXPRESSO_ADICIONAL_CENTAVOS   margem sobre o custo (padrão 1000 = R$ 10,00)
 *   FRETE_EXPRESSO_GANHO_MIN_DIAS     Expresso só aparece se chegar N dias antes (padrão 2)
 *   FRETE_EXPRESSO_TOLERANCIA_DIAS    aceita até N dias a mais que a mais rápida, se for mais barata (padrão 1)
 *   FRETE_DIAS_PREPARO                dias úteis somados ao prazo da transportadora (padrão 1 — postagem)
 *   FRETE_ITEM_CM                     "comprimento x largura x altura" por armação (padrão 18x10x7)
 *   FRETE_ITEM_KG                     peso por armação com case e caixa (padrão 0.3)
 *   FRETE_SEGURO_CENTAVOS             valor declarado (padrão 0 = sem seguro)
 *   FRETE_TRANSPORTADORAS             empresas aceitas, separadas por vírgula, ou "*" pra todas
 *                                     (padrão "Correios,Jadlog,Loggi,JeT" — as que têm ponto de
 *                                     postagem simples; Azul/LATAM/Buslog exigem ir a aeroporto/rodoviária)
 *   FRETE_TIMEOUT_MS                  espera máxima pela API (padrão 8000)
 */

const AMBIENTES = {
  production: 'https://melhorenvio.com.br/api/v2/me/shipment/calculate',
  sandbox: 'https://sandbox.melhorenvio.com.br/api/v2/me/shipment/calculate',
};

export const OPCOES_FRETE = ['ECONOMICO', 'EXPRESSO'];

const TITULOS = {
  ECONOMICO: 'Econômico',
  EXPRESSO: 'Expresso',
};

function num(nome, padrao) {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) ? v : padrao;
}

export function configFrete() {
  const [c, l, a] = String(process.env.FRETE_ITEM_CM || '18x10x7').toLowerCase().split('x').map((s) => Number(s.trim()));
  const lista = String(process.env.FRETE_TRANSPORTADORAS ?? 'Correios,Jadlog,Loggi,JeT').trim();
  return {
    token: process.env.MELHOR_ENVIO_TOKEN || '',
    url: AMBIENTES[(process.env.MELHOR_ENVIO_AMBIENTE || 'production').toLowerCase()] || AMBIENTES.production,
    cepOrigem: String(process.env.FRETE_CEP_ORIGEM || '09607000').replace(/\D/g, ''),
    adicionalEconomico: num('FRETE_ECONOMICO_ADICIONAL_CENTAVOS', 300),
    adicionalExpresso: num('FRETE_EXPRESSO_ADICIONAL_CENTAVOS', 1000),
    ganhoMinDias: num('FRETE_EXPRESSO_GANHO_MIN_DIAS', 2),
    toleranciaDias: num('FRETE_EXPRESSO_TOLERANCIA_DIAS', 1),
    diasPreparo: num('FRETE_DIAS_PREPARO', 1),
    item: { comprimento: c || 18, largura: l || 10, altura: a || 7, kg: num('FRETE_ITEM_KG', 0.3) },
    seguroCentavos: num('FRETE_SEGURO_CENTAVOS', 0),
    transportadoras: lista === '*' || lista === '' ? null : lista.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    timeoutMs: num('FRETE_TIMEOUT_MS', 8000),
  };
}

// ---------------------------------------------------------------------------
// Preço de venda
// ---------------------------------------------------------------------------

/**
 * custo + adicional, arredondado PRA CIMA até o próximo valor terminado em ,90.
 *   1586 + 300 = 1886 → 1890 ; 2120 + 1000 = 3120 → 3190 ; 1590 + 300 = 1890 → 1890
 */
export function precoDeVenda(custoCentavos, adicionalCentavos) {
  const bruto = Math.max(0, Math.round(custoCentavos + adicionalCentavos));
  if (bruto === 0) return 0;
  return Math.ceil((bruto - 90) / 100) * 100 + 90;
}

// ---------------------------------------------------------------------------
// Volume do pedido
// ---------------------------------------------------------------------------

/** Um volume só: as caixas empilham na altura. Peso = por armação × unidades. */
export function volumeDoPedido(unidades, cfg = configFrete()) {
  const n = Math.max(1, Number(unidades) || 1);
  return {
    height: Math.max(1, Math.round(cfg.item.altura * n)),
    width: Math.max(1, Math.round(cfg.item.largura)),
    length: Math.max(1, Math.round(cfg.item.comprimento)),
    weight: Number((cfg.item.kg * n).toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Melhor Envio
// ---------------------------------------------------------------------------

export class MelhorEnvioError extends Error {
  constructor(message, status) { super(message); this.name = 'MelhorEnvioError'; this.status = status || 0; }
}

const cache = new Map();
const CACHE_TTL_MS = 15 * 60_000;

/**
 * Cota TODOS os serviços no Melhor Envio. Devolve a lista já normalizada:
 *   [{ id, servico, transportadora, custo_centavos, prazo_dias }]
 * Serviços com erro ("não atende este trecho", "dimensões ultrapassam") saem da lista.
 */
export async function cotarMelhorEnvio({ cepDestino, unidades, subtotalCentavos = 0 }, cfg = configFrete()) {
  const cep = String(cepDestino || '').replace(/\D/g, '');
  if (cep.length !== 8) throw new MelhorEnvioError('CEP de destino inválido.');
  if (!cfg.token) throw new MelhorEnvioError('MELHOR_ENVIO_TOKEN não configurado.');

  const chave = `${cfg.cepOrigem}:${cep}:${unidades}:${cfg.seguroCentavos}`;
  const emCache = cache.get(chave);
  if (emCache && Date.now() - emCache.em < CACHE_TTL_MS) return emCache.servicos;

  const body = {
    from: { postal_code: cfg.cepOrigem },
    to: { postal_code: cep },
    package: volumeDoPedido(unidades, cfg),
    options: {
      insurance_value: Number((cfg.seguroCentavos / 100).toFixed(2)),
      receipt: false,
      own_hand: false,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
        // O Melhor Envio pede identificação da aplicação com um e-mail de contato.
        'User-Agent': process.env.MELHOR_ENVIO_USER_AGENT || 'Só Armação (contato@soarmacao.com.br)',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    throw new MelhorEnvioError(e.name === 'AbortError' ? `Melhor Envio não respondeu em ${cfg.timeoutMs} ms.` : `Melhor Envio inacessível: ${e.message}`);
  }
  clearTimeout(timer);

  const texto = await res.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = null; }
  if (!res.ok) {
    const msg = dados?.message || dados?.error || texto.slice(0, 200);
    throw new MelhorEnvioError(`Melhor Envio HTTP ${res.status}: ${msg}`, res.status);
  }
  if (!Array.isArray(dados)) throw new MelhorEnvioError('Resposta inesperada do Melhor Envio.');

  const servicos = normalizarServicos(dados, cfg);
  if (!servicos.length) throw new MelhorEnvioError('Nenhuma transportadora atende este CEP.');

  if (cache.size > 500) cache.clear();
  cache.set(chave, { em: Date.now(), servicos });
  return servicos;
}

/** Filtra erros e transportadoras fora da lista; converte preço em centavos. */
export function normalizarServicos(lista, cfg = configFrete()) {
  const aceita = (empresa) => !cfg.transportadoras || cfg.transportadoras.includes(String(empresa || '').toLowerCase());
  return (lista || [])
    .filter((s) => s && !s.error && s.price != null)
    .map((s) => ({
      id: Number(s.id),
      servico: String(s.name || '').trim(),
      transportadora: String(s.company?.name || '').trim(),
      // `price` é o custo real da etiqueta. `custom_price` seria o ajuste
      // configurado no painel — a margem aqui é nossa, então ignoramos.
      custo_centavos: Math.round(Number(s.price) * 100),
      prazo_dias: Number(s.delivery_time ?? s.custom_delivery_time ?? 0),
    }))
    .filter((s) => s.custo_centavos > 0 && Number.isFinite(s.prazo_dias) && aceita(s.transportadora));
}

// ---------------------------------------------------------------------------
// Regra Econômico / Expresso
// ---------------------------------------------------------------------------

/**
 * Recebe a lista normalizada e devolve as opções de venda:
 *   { ECONOMICO: {...}, EXPRESSO: {...} | null }
 * Cada opção: { codigo, titulo, servico_id, servico, transportadora,
 *               custo_centavos, preco_centavos, prazo_dias, prazo }
 */
export function montarOpcoes(servicos, cfg = configFrete()) {
  const validos = (servicos || []).filter((s) => s.custo_centavos > 0);
  if (!validos.length) return { ECONOMICO: null, EXPRESSO: null };

  const porPreco = (a, b) => a.custo_centavos - b.custo_centavos || a.prazo_dias - b.prazo_dias;
  const economico = validos.slice().sort(porPreco)[0];

  // Candidatas a Expresso: chegam pelo menos `ganhoMinDias` antes da Econômica.
  const candidatas = validos.filter((s) => s.prazo_dias <= economico.prazo_dias - cfg.ganhoMinDias);
  let expresso = null;
  if (candidatas.length) {
    const maisRapido = Math.min(...candidatas.map((s) => s.prazo_dias));
    expresso = candidatas
      .filter((s) => s.prazo_dias <= maisRapido + cfg.toleranciaDias)
      .sort(porPreco)[0] || null;
  }

  const montar = (s, codigo, adicional) => s && {
    codigo,
    titulo: TITULOS[codigo],
    servico_id: s.id,
    servico: s.servico,
    transportadora: s.transportadora,
    custo_centavos: s.custo_centavos,
    preco_centavos: precoDeVenda(s.custo_centavos, adicional),
    prazo_dias: s.prazo_dias,
    prazo: textoPrazo(s.prazo_dias, cfg),
  };

  const E = montar(economico, 'ECONOMICO', cfg.adicionalEconomico);
  let X = montar(expresso, 'EXPRESSO', cfg.adicionalExpresso);
  // Expresso só faz sentido se for mais caro E mais rápido que o Econômico.
  if (X && (X.preco_centavos <= E.preco_centavos || X.prazo_dias >= E.prazo_dias)) X = null;
  return { ECONOMICO: E, EXPRESSO: X };
}

export function textoPrazo(prazoDias, cfg = configFrete()) {
  const d = Math.max(1, Math.round(Number(prazoDias) || 0) + cfg.diasPreparo);
  return d === 1 ? 'até 1 dia útil' : `até ${d} dias úteis`;
}

/** Versão pública (sem transportadora/custo) — o que a loja mostra. */
export function opcoesPublicas(opcoes) {
  return OPCOES_FRETE
    .map((c) => opcoes?.[c])
    .filter(Boolean)
    .map((o) => ({ codigo: o.codigo, titulo: o.titulo, prazo: o.prazo, prazo_dias: o.prazo_dias, preco: Number((o.preco_centavos / 100).toFixed(2)) }));
}

/**
 * Ponto de entrada usado pelo catálogo: cota, monta as opções e escolhe a que
 * o comprador pediu. Se a pedida não existir (ex.: EXPRESSO num CEP sem opção
 * rápida), volta pra ECONOMICO — e a resposta diz qual ficou.
 *
 * Nunca lança por falha do Melhor Envio: devolve `null` pra o chamador cair
 * na tabela fixa. Só lança em erro de programação (sem CEP, etc.).
 */
export async function cotarFrete({ cepDestino, unidades, opcao = 'ECONOMICO', subtotalCentavos = 0, servicos = null }, cfg = configFrete()) {
  let lista = servicos;
  if (!lista) {
    try {
      lista = await cotarMelhorEnvio({ cepDestino, unidades, subtotalCentavos }, cfg);
    } catch (e) {
      console.warn('[frete] Melhor Envio indisponível, usando tabela fixa:', e.message);
      return null;
    }
  }
  const opcoes = montarOpcoes(lista, cfg);
  if (!opcoes.ECONOMICO) return null;
  const pedida = OPCOES_FRETE.includes(String(opcao || '').toUpperCase()) ? String(opcao).toUpperCase() : 'ECONOMICO';
  const escolhida = opcoes[pedida] || opcoes.ECONOMICO;
  return { origem: 'melhor_envio', opcoes, escolhida };
}
