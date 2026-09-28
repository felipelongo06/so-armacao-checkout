/**
 * PEDIDO PAGO → PEDIDO DE VENDA NO BLING.
 *
 * Chamado pelo webhook do Asaas assim que o pagamento confirma (e repetido
 * pelo cron de reconciliação / script manual se falhar). Cria no Bling:
 *
 *   1. O contato do comprador (procura pelo CPF; cria se não existir). O CPF
 *      vem do cadastro do cliente no ASAAS — o nosso banco guarda só o hash,
 *      e a NF-e precisa do número.
 *   2. O pedido de venda com os itens (ligados ao produto do Bling pelo
 *      `bling_id`, pra baixar estoque), o desconto do 2º óculos, o endereço
 *      de entrega na etiqueta, o FRETE COBRADO da cliente e, no volume e nas
 *      observações, o SERVIÇO que ela pagou (ex.: "Expresso — Correios SEDEX,
 *      custo R$ 50,11 / cobrado R$ 60,90"). Quem gera a etiqueta no Bling
 *      Envios escolhe exatamente esse serviço.
 *
 * Nunca derruba o webhook: qualquer falha vira `bling_erro` no pedido e a
 * criação é tentada de novo pelo cron (até BLING_PEDIDO_MAX_TENTATIVAS).
 *
 * Variáveis opcionais:
 *   BLING_LOJA_ID                     id da "loja" (canal) no Bling pra classificar o pedido
 *   BLING_FORMA_PAGAMENTO_PIX_ID      id da forma de pagamento "Pix" no Bling (senão não manda parcelas)
 *   BLING_FORMA_PAGAMENTO_CARTAO_ID   idem para cartão de crédito
 *   BLING_SITUACAO_PAGO_ID            id da situação em que o pedido nasce (senão fica no padrão "Em aberto")
 *   BLING_PEDIDO_MAX_TENTATIVAS       padrão 5
 */
import { bling, BlingError } from './bling.js';
import { asaas } from './asaas.js';
import { exigirSupabase } from './supabase.js';

const MAX_TENTATIVAS = Number(process.env.BLING_PEDIDO_MAX_TENTATIVAS || 5);

const reais = (c) => Number(((Number(c) || 0) / 100).toFixed(2));
const brl = (c) => `R$ ${reais(c).toFixed(2).replace('.', ',')}`;
const digitos = (s) => String(s || '').replace(/\D/g, '');
const cepFormatado = (cep) => { const d = digitos(cep); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };

function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ---------------------------------------------------------------------------
// Contato
// ---------------------------------------------------------------------------

async function cpfDoPedido(pedido) {
  if (!pedido.asaas_customer_id) return null;
  try {
    const c = await asaas.getCustomer(pedido.asaas_customer_id);
    const doc = digitos(c?.cpfCnpj);
    return doc.length === 11 || doc.length === 14 ? doc : null;
  } catch (e) {
    console.warn('[bling-pedido] CPF indisponível no Asaas:', e.message);
    return null;
  }
}

async function procurarContato(cpf) {
  if (!cpf) return null;
  const r = await bling('GET', '/contatos', { query: { pesquisa: cpf, limite: 20 } });
  const achado = (r?.data || []).find((c) => digitos(c.numeroDocumento) === cpf);
  return achado ? achado.id : null;
}

async function criarContato(pedido, cpf) {
  const body = {
    nome: pedido.cliente_nome,
    situacao: 'A',
    tipo: cpf && cpf.length === 14 ? 'J' : 'F',
    indicadorIe: 9, // não contribuinte de ICMS
    ...(cpf ? { numeroDocumento: cpf } : {}),
    celular: digitos(pedido.cliente_telefone) || undefined,
    email: pedido.cliente_email || undefined,
    endereco: {
      geral: {
        endereco: pedido.cliente_endereco || '',
        numero: pedido.cliente_numero || 'S/N',
        complemento: pedido.cliente_complemento || '',
        bairro: pedido.cliente_bairro || '',
        cep: cepFormatado(pedido.cliente_cep),
        municipio: pedido.cliente_cidade || '',
        uf: pedido.cliente_uf || '',
      },
    },
  };
  const r = await bling('POST', '/contatos', { body });
  const id = r?.data?.id;
  if (!id) throw new BlingError(502, 'Bling criou o contato sem devolver id.', r);
  return id;
}

/** Devolve { id, cpf } do contato no Bling (procura, senão cria). */
export async function garantirContato(pedido) {
  if (pedido.bling_contato_id) return { id: pedido.bling_contato_id, cpf: null };
  const cpf = await cpfDoPedido(pedido);
  const existente = await procurarContato(cpf);
  if (existente) return { id: existente, cpf };
  return { id: await criarContato(pedido, cpf), cpf };
}

// ---------------------------------------------------------------------------
// Pedido de venda
// ---------------------------------------------------------------------------

async function idsDosProdutos(skus) {
  const db = exigirSupabase();
  const { data } = await db.from('produtos').select('sku, bling_id').in('sku', skus);
  return Object.fromEntries((data || []).filter((p) => p.bling_id).map((p) => [p.sku, p.bling_id]));
}

function textoFrete(pedido) {
  const opcao = pedido.frete_opcao === 'EXPRESSO' ? 'Expresso' : 'Econômico';
  const servico = [pedido.frete_transportadora, pedido.frete_servico].filter(Boolean).join(' ');
  const partes = [`FRETE ${opcao.toUpperCase()}`];
  partes.push(servico ? `serviço: ${servico}` : 'serviço: tabela fixa (Melhor Envio indisponível na cotação) — escolha a etiqueta mais barata');
  if (pedido.frete_prazo_dias != null) partes.push(`prazo da transportadora: ${pedido.frete_prazo_dias} d.u.`);
  if (pedido.frete_custo_centavos != null) partes.push(`custo cotado ${brl(pedido.frete_custo_centavos)}`);
  partes.push(`cobrado da cliente ${brl(pedido.frete_centavos)}`);
  return partes.join(' · ');
}

/** Monta o payload do POST /pedidos/vendas (puro — sem chamadas externas). */
export function montarPayloadPedido(pedido, contatoId, blingIds = {}) {
  const itens = (pedido.itens || []).map((i) => ({
    codigo: i.sku,
    descricao: i.nome,
    unidade: 'UN',
    quantidade: Number(i.qty),
    valor: reais(i.preco_unit_centavos),
    desconto: 0,
    ...(blingIds[i.sku] ? { produto: { id: blingIds[i.sku] } } : {}),
  }));

  const semProduto = itens.filter((i) => !i.produto).map((i) => i.codigo);
  const metodo = pedido.metodo === 'CREDIT_CARD' ? 'Cartão de crédito' : 'Pix';
  const formaPagamentoId = Number(pedido.metodo === 'CREDIT_CARD'
    ? process.env.BLING_FORMA_PAGAMENTO_CARTAO_ID
    : process.env.BLING_FORMA_PAGAMENTO_PIX_ID) || null;

  const observacoesInternas = [
    `Pedido ${pedido.id} — ${metodo} via Asaas (${pedido.asaas_payment_id || 'sem id'}), pago em ${pedido.pago_em || hojeSP()}.`,
    textoFrete(pedido),
    pedido.desconto_centavos > 0 ? `Desconto de ${pedido.desconto_pct}% no 2º óculos: ${brl(pedido.desconto_centavos)}.` : null,
    semProduto.length ? `ATENÇÃO: sem vínculo com produto do Bling (estoque não baixa): ${semProduto.join(', ')}.` : null,
    pedido.observacao || null,
  ].filter(Boolean).join('\n');

  const payload = {
    numeroLoja: pedido.id,
    data: hojeSP(),
    contato: { id: contatoId },
    itens,
    ...(pedido.desconto_centavos > 0 ? { desconto: { valor: reais(pedido.desconto_centavos), unidade: 'REAL' } } : {}),
    transporte: {
      fretePorConta: 0, // CIF: a loja contrata a transportadora; o frete cobrado entra no total
      frete: reais(pedido.frete_centavos),
      quantidadeVolumes: 1,
      pesoBruto: Number((0.3 * Math.max(1, Number(pedido.total_unidades) || 1)).toFixed(3)),
      ...(pedido.frete_prazo_dias != null ? { prazoEntrega: Number(pedido.frete_prazo_dias) } : {}),
      etiqueta: {
        nome: pedido.cliente_nome,
        endereco: pedido.cliente_endereco || '',
        numero: pedido.cliente_numero || 'S/N',
        complemento: pedido.cliente_complemento || '',
        municipio: pedido.cliente_cidade || '',
        uf: pedido.cliente_uf || '',
        cep: cepFormatado(pedido.cliente_cep),
        bairro: pedido.cliente_bairro || '',
      },
      volumes: [{
        servico: [pedido.frete_transportadora, pedido.frete_servico].filter(Boolean).join(' ') || (pedido.frete_opcao === 'EXPRESSO' ? 'Expresso' : 'Econômico'),
      }],
    },
    // Observações vão pra NF-e/impressão; o serviço aqui é o que a expedição lê.
    observacoes: textoFrete(pedido),
    observacoesInternas,
    ...(process.env.BLING_LOJA_ID ? { loja: { id: Number(process.env.BLING_LOJA_ID) } } : {}),
    ...(process.env.BLING_SITUACAO_PAGO_ID ? { situacao: { id: Number(process.env.BLING_SITUACAO_PAGO_ID) } } : {}),
    ...(formaPagamentoId ? {
      parcelas: [{
        dataVencimento: hojeSP(),
        valor: reais(pedido.valor_pago_centavos || pedido.total_centavos),
        observacoes: `${metodo} Asaas ${pedido.asaas_payment_id || ''}`.trim(),
        formaPagamento: { id: formaPagamentoId },
      }],
    } : {}),
  };
  return payload;
}

/**
 * Cria o pedido no Bling e grava o resultado no Supabase.
 * Idempotente: se `bling_pedido_id` já existe, não faz nada.
 * @param {string|object} pedidoOuId  id do pedido ou a linha inteira de `pedidos`
 * @param {object} opcoes.dryRun      só monta e devolve o payload, sem chamar o Bling
 */
export async function criarPedidoNoBling(pedidoOuId, { dryRun = false } = {}) {
  const db = exigirSupabase();
  let pedido = pedidoOuId;
  if (typeof pedidoOuId === 'string') {
    const { data, error } = await db.from('pedidos').select('*').eq('id', pedidoOuId).maybeSingle();
    if (error) throw new Error(`Falha ao ler o pedido: ${error.message}`);
    if (!data) throw new Error(`Pedido ${pedidoOuId} não encontrado.`);
    pedido = data;
  }

  if (pedido.bling_pedido_id) return { ok: true, jaExistia: true, bling_pedido_id: pedido.bling_pedido_id };
  if (pedido.status !== 'PAGO') return { ok: false, motivo: `status ${pedido.status} (só PAGO vai pro Bling)` };

  const tentativas = Number(pedido.bling_tentativas) || 0;
  if (!dryRun && tentativas >= MAX_TENTATIVAS) {
    return { ok: false, motivo: `${tentativas} tentativas — desistiu; crie à mão ou rode scripts/bling-pedido.js --forcar` };
  }

  try {
    const blingIds = await idsDosProdutos((pedido.itens || []).map((i) => i.sku));
    if (dryRun) {
      return { ok: true, dryRun: true, payload: montarPayloadPedido(pedido, pedido.bling_contato_id || 0, blingIds) };
    }

    const contato = await garantirContato(pedido);
    const payload = montarPayloadPedido(pedido, contato.id, blingIds);
    const r = await bling('POST', '/pedidos/vendas', { body: payload });
    const id = r?.data?.id;
    if (!id) throw new BlingError(502, 'Bling criou o pedido sem devolver id.', r);

    await db.from('pedidos').update({
      bling_contato_id: contato.id,
      bling_pedido_id: id,
      bling_pedido_numero: r?.data?.numero != null ? String(r.data.numero) : null,
      bling_criado_em: new Date().toISOString(),
      bling_erro: null,
      bling_tentativas: tentativas + 1,
    }).eq('id', pedido.id);

    console.log(`[bling-pedido] pedido ${pedido.id} criado no Bling: id ${id}${r?.data?.numero ? ` (nº ${r.data.numero})` : ''}`);
    return { ok: true, bling_pedido_id: id, bling_pedido_numero: r?.data?.numero ?? null, contato_id: contato.id };
  } catch (e) {
    const detalhe = e instanceof BlingError && e.corpo ? ` ${JSON.stringify(e.corpo).slice(0, 600)}` : '';
    const msg = `${e.message}${detalhe}`.slice(0, 1000);
    console.error(`[bling-pedido] falha no pedido ${pedido.id}:`, msg);
    await db.from('pedidos').update({
      bling_erro: msg,
      bling_tentativas: tentativas + 1,
    }).eq('id', pedido.id);
    return { ok: false, erro: msg };
  }
}

/**
 * Pedidos PAGOS ainda sem pedido no Bling (pro cron e pro script manual).
 */
export async function pendentesDeBling({ desde, limite = 20 } = {}) {
  const db = exigirSupabase();
  let q = db.from('pedidos').select('*').eq('status', 'PAGO').is('bling_pedido_id', null)
    .lt('bling_tentativas', MAX_TENTATIVAS).order('pago_em', { ascending: true }).limit(limite);
  if (desde) q = q.gte('pago_em', desde);
  const { data, error } = await q;
  if (error) throw new Error(`Falha ao listar pendentes do Bling: ${error.message}`);
  return data || [];
}
