/**
 * POST /api/checkout
 *
 * Body (o navegador manda SO isto — nunca preços):
 * {
 *   itens: [{ sku: "SA-D1", qty: 2 }],
 *   cliente: { nome, cpf, email, telefone, cep, numero, complemento },
 *   metodo: "PIX" | "CREDIT_CARD",
 *   parcelas: 1,
 *   tracking: { ga_client_id, ga_session_id, fbp, fbc, source_url }
 * }
 */
import { asaas, AsaasError, isSandbox } from '../lib/asaas.js';
import { consultarCep } from '../lib/cep.js';
import { montarPedido, resumoPublico, ValidacaoError, CatalogoIndisponivelError, centavosParaReais } from '../lib/catalogo.js';
import { supabase } from '../lib/supabase.js';
import { aplicarCors, rateLimit, apenasMetodo } from '../lib/http.js';
import {
  cpfValido, emailValido, telefoneValido, cepValido,
  limparDigitos, hashCpf, ipDoCliente,
} from '../lib/validacao.js';

export default async function handler(req, res) {
  if (aplicarCors(req, res)) return;
  if (apenasMetodo(req, res, 'POST')) return;

  const ip = ipDoCliente(req);
  if (!rateLimit(`checkout:${ip}`, { max: 8, janelaMs: 60_000 })) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um minuto.' });
  }

  try {
    const { itens, cliente = {}, metodo = 'PIX', parcelas = 1, tracking = {} } = req.body || {};

    // ---- validacao do cliente ----
    const nome = String(cliente.nome || '').trim();
    if (nome.length < 3 || !nome.includes(' ')) throw new ValidacaoError('Informe o nome completo.');
    if (!cpfValido(cliente.cpf)) throw new ValidacaoError('CPF invalido.');
    if (!emailValido(cliente.email)) throw new ValidacaoError('E-mail invalido.');
    if (!telefoneValido(cliente.telefone)) throw new ValidacaoError('Telefone invalido.');
    if (!cepValido(cliente.cep)) throw new ValidacaoError('CEP invalido.');
    if (!['PIX', 'CREDIT_CARD'].includes(metodo)) throw new ValidacaoError('Meio de pagamento invalido.');

    const nParcelas = Math.min(Math.max(parseInt(parcelas, 10) || 1, 1), 12);

    // ---- preço recalculado no servidor ----
    const pedido = await montarPedido(itens, cliente.cep);

    // ---- endereço a partir do CEP (não confia no que o navegador manda) ----
    const endereco = await consultarCep(cliente.cep);

    // ---- cliente no Asaas ----
    const numero = String(cliente.numero || 'S/N');
    // O Asaas declara addressNumber como inteiro: "S/N" não converte.
    // Manda só os dígitos, e omite o campo quando não houver nenhum.
    const numeroAsaas = limparDigitos(cliente.numero) || undefined;
    const customer = await asaas.findOrCreateCustomer({
      name: nome,
      cpfCnpj: limparDigitos(cliente.cpf),
      email: String(cliente.email).trim().toLowerCase(),
      mobilePhone: limparDigitos(cliente.telefone),
      // Endereço só entra completo. Mandar CEP e número sem a rua faz o
      // Asaas recusar com "O campo address deve ser informado".
      ...(endereco?.logradouro ? {
        postalCode: limparDigitos(cliente.cep),
        address: endereco.logradouro,
        addressNumber: numeroAsaas,
        complement: cliente.complemento || undefined,
        province: endereco.bairro || undefined,
      } : {}),
    });

    // ---- pedido no banco (antes de cobrar, pra ter rastro) ----
    const pedidoId = `SA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    if (supabase) {
      const { error } = await supabase.from('pedidos').insert({
        id: pedidoId,
        status: 'AGUARDANDO_PAGAMENTO',
        metodo,
        itens: pedido.itens,
        total_unidades: pedido.total_unidades,
        subtotal_centavos: pedido.subtotal_centavos,
        desconto_pct: pedido.desconto_pct,
        desconto_centavos: pedido.desconto_centavos,
        frete_centavos: pedido.frete_centavos,
        total_centavos: pedido.total_centavos,
        cliente_nome: nome,
        cliente_email: String(cliente.email).trim().toLowerCase(),
        cliente_telefone: limparDigitos(cliente.telefone),
        cliente_cpf_hash: hashCpf(cliente.cpf),   // LGPD: CPF cru nao e persistido
        cliente_cep: limparDigitos(cliente.cep),
        cliente_numero: numero,
        cliente_complemento: cliente.complemento || null,
        cliente_endereco: endereco?.logradouro || null,
        cliente_bairro: endereco?.bairro || null,
        cliente_cidade: endereco?.cidade || null,
        cliente_uf: endereco?.uf || null,
        asaas_customer_id: customer.id,
        ip,
        user_agent: req.headers['user-agent'] || null,
        ga_client_id: tracking.ga_client_id || null,
        ga_session_id: tracking.ga_session_id || null,
        fbp: tracking.fbp || null,
        fbc: tracking.fbc || null,
        source_url: tracking.source_url || null,
      });
      if (error) console.error('[checkout] falha ao gravar pedido:', error.message);
    }

    const hoje = new Date().toISOString().slice(0, 10);
    const base = {
      customer: customer.id,
      value: centavosParaReais(pedido.total_centavos),
      dueDate: hoje,
      description: `Pedido ${pedidoId} — ${pedido.descricao}`,
      externalReference: pedidoId,
    };

    // ================= PIX =================
    if (metodo === 'PIX') {
      const cobranca = await asaas.createPayment({ ...base, billingType: 'PIX' });
      const qr = await asaas.getPixQrCode(cobranca.id);

      if (supabase) {
        await supabase.from('pedidos')
          .update({ asaas_payment_id: cobranca.id }).eq('id', pedidoId);
      }

      return res.status(200).json({
        pedido_id: pedidoId,
        asaas_payment_id: cobranca.id,
        metodo: 'PIX',
        resumo: resumoPublico(pedido),
        pix: {
          qrcode_base64: qr.encodedImage,
          copia_e_cola: qr.payload,
          expira_em: qr.expirationDate,
        },
        ambiente: isSandbox() ? 'sandbox' : 'production',
      });
    }

    // ============== CARTAO DE CREDITO ==============
    // Checkout hospedado do Asaas: os dados do cartao NUNCA passam pelo nosso
    // servidor, o que mantem o escopo PCI-DSS no minimo (SAQ-A).
    // chargeTypes e installment andam juntos: se declarar INSTALLMENT sem o
    // objeto `installment`, o Asaas recusa a criacao.
    const parcelado = nParcelas > 1;
    const checkout = await asaas.createCheckout({
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: parcelado ? ['DETACHED', 'INSTALLMENT'] : ['DETACHED'],
      minutesToExpire: 30,
      callback: {
        successUrl: `${process.env.SITE_URL}/confirmacao?pedido=${pedidoId}`,
        cancelUrl: `${process.env.SITE_URL}/carrinho`,
        expiredUrl: `${process.env.SITE_URL}/carrinho`,
      },
      items: [{
        name: `Pedido ${pedidoId}`,
        description: pedido.descricao,
        quantity: 1,
        value: centavosParaReais(pedido.total_centavos),
      }],
      // O checkout hospedado exige endereço completo para a análise antifraude.
      customerData: {
        name: nome,
        cpfCnpj: limparDigitos(cliente.cpf),
        email: String(cliente.email).trim().toLowerCase(),
        phone: limparDigitos(cliente.telefone),
        address: endereco?.logradouro || undefined,
        addressNumber: numeroAsaas,
        complement: cliente.complemento || undefined,
        province: endereco?.bairro || undefined,
        postalCode: limparDigitos(cliente.cep),
      },
      installment: parcelado ? { maxInstallmentCount: nParcelas } : undefined,
      externalReference: pedidoId,
    });

    // Formato documentado do link (mesmo host em sandbox e producao).
    const url = checkout.link || checkout.url
      || (checkout.id ? `https://asaas.com/checkoutSession/show?id=${checkout.id}` : null);
    if (!url) throw new AsaasError(502, [{ description: 'Checkout criado sem link utilizavel.' }]);

    if (supabase) {
      await supabase.from('pedidos')
        .update({ asaas_checkout_id: checkout.id || null }).eq('id', pedidoId);
    }

    return res.status(200).json({
      pedido_id: pedidoId,
      metodo: 'CREDIT_CARD',
      resumo: resumoPublico(pedido),
      checkout_url: url,
      ambiente: isSandbox() ? 'sandbox' : 'production',
    });

  } catch (err) {
    if (err instanceof ValidacaoError) return res.status(400).json({ erro: err.message });
    if (err instanceof CatalogoIndisponivelError) {
      console.error('[checkout] catalogo:', err.message);
      return res.status(503).json({ erro: 'Catalogo indisponivel no momento. Tente novamente em instantes.' });
    }
    if (err instanceof AsaasError) {
      console.error('[checkout] Asaas:', err.status, err.code, err.message);
      return res.status(err.status === 401 ? 500 : 400).json({
        erro: err.status === 401
          ? 'Pagamento indisponivel no momento. Tente novamente em instantes.'
          : err.message,
      });
    }
    console.error('[checkout] erro inesperado:', err);
    return res.status(500).json({ erro: 'Nao foi possivel iniciar o pagamento.' });
  }
}

