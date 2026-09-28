/**
 * FRETE DINÂMICO — Melhor Envio + regra "Econômico / Expresso".
 *
 * O que este módulo faz, nesta ordem:
 *   1. Cota no Melhor Envio (a mesma API da calculadora do painel) todas as
 *      transportadoras pro CEP do comprador e pro volume do pedido.
 *   2. Escolhe DUAS opções pra loja mostrar, sem nome de transportadora:
 *        ECONOMICO = a etiqueta mais barata.
 *        EXPRESSO  = a transportadora MAIS RÁPIDA disponível (empate = mais barata).
 *      O Expresso sempre aparece — é alavanca de margem. Ele mostra sempre um
 *      prazo menor que o Econômico no cartão: quando existe uma transportadora
 *      de fato mais rápida, usa o prazo real dela; quando a mais barata já é a
 *      mais rápida (mesma transportadora), o ECONÔMICO ganha +FRETE_ECONOMICO_PAD_DIAS
 *      dias no prazo exibido e o Expresso fica com a data real — assim o
 *      Expresso nunca promete uma rapidez que não existe.
 *   3. Preço: Econômico = custo + FRETE_ECONOMICO_ADICIONAL (arredondado pra ,90).
 *      Expresso = Econômico + FRETE_EXPRESSO_ADICIONAL (fixo, R$ 10), com PISO:
 *      nunca abaixo do custo da transportadora rápida + a margem do econômico —
 *      então o Expresso jamais dá prejuízo, mesmo despachando por uma cara.
 *   4. Se o Melhor Envio falhar (não conectado, timeout, erro), cai na TABELA
 *      FIXA por região (lib/catalogo.js) como opção única — a loja nunca fica
 *      sem frete.
 *
 * O token vem do OAuth com refresh automático (lib/melhor-envio.js): conecta-se
 * uma vez com scripts/melhor-envio-conectar.js e o token renova sozinho. Dá pra
 * forçar um token cru pelo env MELHOR_ENVIO_TOKEN (só pra teste rápido).
 *
 * O que a cliente vê é só "Econômico / Expresso", prazo e preço. Transportadora,
 * serviço, custo e origem ficam gravados no pedido, pro Bling e pra conferência.
 *
 * Variáveis de ambiente (todas opcionais; a conexão OAuth cobre a autenticação):
 *   MELHOR_ENVIO_TOKEN                OPCIONAL: access_token cru (pula o OAuth; expira e não renova)
 *   MELHOR_ENVIO_AMBIENTE             "production" (padrão) | "sandbox"
 *   FRETE_CEP_ORIGEM                  CEP de postagem (padrão 09607000, o da conta)
 *   FRETE_ECONOMICO_ADICIONAL_CENTAVOS  margem sobre o custo, no Econômico (padrão 300 = R$ 3,00)
 *   FRETE_EXPRESSO_ADICIONAL_CENTAVOS   quanto o Expresso custa A MAIS que o Econômico (padrão 1000 = R$ 10,00 fixo)
 *   FRETE_ECONOMICO_PAD_DIAS          dias somados ao prazo do Econômico quando a mais barata já é a mais rápida (padrão 2)
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

// IDs de serviço da conta, usados como fallback se o GET /services falhar.
// Sem o parâmetro `services` na requisição, o /calculate devolve UM serviço só
// (em vez da lista) — por isso sempre mandamos a lista.
const SERVICOS_FALLBACK = [1, 2, 3, 4, 12, 15, 16, 17, 22, 27, 31, 32, 33, 34, 35];

import { obterAccessToken, MelhorEnvioAuthError } from './melhor-envio.js';

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
    // Quanto o Expresso custa A MAIS que o Econômico (fixo).
    adicionalExpresso: num('FRETE_EXPRESSO_ADICIONAL_CENTAVOS', 1000),
    // Dias somados ao prazo do Econômico quando a mais barata já é a mais rápida.
    padDiasEconomico: num('FRETE_ECONOMICO_PAD_DIAS', 2),
    diasPreparo: num('FRETE_DIAS_PREPARO', 1),
    item: { comprimento: c || 18, largura: l || 10, altura: a || 7, kg: num('FRETE_ITEM_KG', 0.3) },
    seguroCentavos: num('FRETE_SEGURO_CENTAVOS', 0),
    transportadoras: lista === '*' || lista === '' ? null : lista.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    timeoutMs: num('FRETE_TIMEOUT_MS', 8000),
    userAgent: process.env.MELHOR_ENVIO_USER_AGENT || 'Só Armação (contato@soarmacao.com.br)',
    servicesUrl: (AMBIENTES[(process.env.MELHOR_ENVIO_AMBIENTE || 'production').toLowerCase()] || AMBIENTES.production).replace('/shipment/calculate', '/shipment/services'),
  };
}

// ---------------------------------------------------------------------------
// Serviços da conta (IDs) — cacheados; o /calculate precisa da lista pra
// devolver todas as transportadoras (senão volta um serviço só).
// ---------------------------------------------------------------------------
let servicosCache = null; // { em, ids }
const SERVICOS_TTL_MS = 6 * 60 * 60_000;

export async function idsDosServicos(token, cfg = configFrete()) {
  if (servicosCache && Date.now() - servicosCache.em < SERVICOS_TTL_MS) return servicosCache.ids;
  try {
    const res = await fetch(cfg.servicesUrl, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': cfg.userAgent },
    });
    const dados = await res.json().catch(() => null);
    const ids = Array.isArray(dados) ? dados.map((s) => Number(s.id)).filter((n) => Number.isFinite(n)) : [];
    const finais = ids.length ? ids : SERVICOS_FALLBACK;
    servicosCache = { em: Date.now(), ids: finais };
    return finais;
  } catch {
    return SERVICOS_FALLBACK; // não cacheia a falha, tenta de novo na próxima
  }
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

  // Token via OAuth com refresh automático (ou override cru no env).
  let token;
  try {
    token = await obterAccessToken();
  } catch (e) {
    throw new MelhorEnvioError(e instanceof MelhorEnvioAuthError ? e.message : `Autenticação Melhor Envio: ${e.message}`, e.status);
  }

  const chave = `${cfg.cepOrigem}:${cep}:${unidades}:${cfg.seguroCentavos}`;
  const emCache = cache.get(chave);
  if (emCache && Date.now() - emCache.em < CACHE_TTL_MS) return emCache.servicos;

  // Sem `services`, o /calculate devolve UM serviço só. Mandamos a lista da conta.
  const services = await idsDosServicos(token, cfg);

  const body = {
    from: { postal_code: cfg.cepOrigem },
    to: { postal_code: cep },
    package: volumeDoPedido(unidades, cfg),
    options: {
      insurance_value: Number((cfg.seguroCentavos / 100).toFixed(2)),
      receipt: false,
      own_hand: false,
    },
    services: services.join(','),
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
        Authorization: `Bearer ${token}`,
        // O Melhor Envio pede identificação da aplicação com um e-mail de contato.
        'User-Agent': cfg.userAgent,
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
  // Normalmente um array; se vier um objeto único (um serviço só), embrulha.
  const lista = Array.isArray(dados) ? dados : (dados && typeof dados === 'object' ? [dados] : null);
  if (!lista) throw new MelhorEnvioError('Resposta inesperada do Melhor Envio.');

  const servicos = normalizarServicos(lista, cfg);
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
 *   { ECONOMICO: {...}, EXPRESSO: {...} }
 * Cada opção: { codigo, titulo, servico_id, servico, transportadora,
 *               custo_centavos, preco_centavos, prazo_dias, prazo }
 *
 * Econômico = mais barata. Expresso = mais rápida (empate = mais barata), sempre
 * presente. Preço do Expresso = Econômico + adicionalExpresso (fixo), com piso
 * = custo da rápida + adicionalEconomico (nunca dá prejuízo). Prazos: se a mais
 * barata já é a mais rápida, o Econômico ganha +padDiasEconomico e o Expresso
 * fica com o prazo real; senão, cada um usa o prazo real (o rápido já é menor).
 */
export function montarOpcoes(servicos, cfg = configFrete()) {
  const validos = (servicos || []).filter((s) => s.custo_centavos > 0);
  if (!validos.length) return { ECONOMICO: null, EXPRESSO: null };

  const porPreco = (a, b) => a.custo_centavos - b.custo_centavos || a.prazo_dias - b.prazo_dias;
  const porPrazo = (a, b) => a.prazo_dias - b.prazo_dias || a.custo_centavos - b.custo_centavos;

  const barato = validos.slice().sort(porPreco)[0];  // Econômico
  const rapido = validos.slice().sort(porPrazo)[0];  // Expresso (mais rápido; empate = mais barato)
  const mesmoServico = rapido.id === barato.id && rapido.transportadora === barato.transportadora;

  // Prazos exibidos: o Expresso sempre fica com um prazo menor que o Econômico.
  // Se a mais barata já é a mais rápida, alonga o Econômico (não encurta o Expresso).
  const prazoEconDias = mesmoServico ? barato.prazo_dias + cfg.padDiasEconomico : barato.prazo_dias;

  const economico = {
    codigo: 'ECONOMICO', titulo: 'Econômico',
    servico_id: barato.id, servico: barato.servico, transportadora: barato.transportadora,
    custo_centavos: barato.custo_centavos,
    preco_centavos: precoDeVenda(barato.custo_centavos, cfg.adicionalEconomico),
    prazo_dias: prazoEconDias,
    prazo: textoPrazo(prazoEconDias, cfg),
  };

  // Expresso = Econômico + adicional fixo, mas nunca abaixo do custo da rápida
  // + a margem do econômico (piso de margem — não dá prejuízo em rota cara).
  const piso = precoDeVenda(rapido.custo_centavos, cfg.adicionalEconomico);
  const precoExpresso = Math.max(economico.preco_centavos + cfg.adicionalExpresso, piso);

  const expresso = {
    codigo: 'EXPRESSO', titulo: 'Expresso',
    servico_id: rapido.id, servico: rapido.servico, transportadora: rapido.transportadora,
    custo_centavos: rapido.custo_centavos,
    preco_centavos: precoExpresso,
    prazo_dias: rapido.prazo_dias,
    prazo: textoPrazo(rapido.prazo_dias, cfg),
  };

  return { ECONOMICO: economico, EXPRESSO: expresso };
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
