/**
 * Cliente HTTP do Asaas.
 * A chave de API vive SOMENTE aqui (server-side, via env var).
 * Doc: https://docs.asaas.com/docs/autenticacao
 */

const ENVS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

function baseUrl() {
  const env = (process.env.ASAAS_ENV || 'sandbox').toLowerCase();
  const url = ENVS[env];
  if (!url) throw new Error(`ASAAS_ENV invalido: "${env}". Use "sandbox" ou "production".`);
  return url;
}

function apiKey() {
  const key = process.env.ASAAS_API_KEY;
  if (!key) throw new Error('ASAAS_API_KEY nao configurada nas variaveis de ambiente.');
  return key;
}

export class AsaasError extends Error {
  constructor(status, errors, raw) {
    const first = Array.isArray(errors) && errors[0];
    super(first?.description || `Erro Asaas (HTTP ${status})`);
    this.name = 'AsaasError';
    this.status = status;
    this.code = first?.code || null;
    this.errors = errors || [];
    this.raw = raw;
  }
}

async function request(method, path, body, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Obrigatorio para contas raiz criadas a partir de 13/06/2024.
        'User-Agent': process.env.ASAAS_USER_AGENT || 'SoArmacao-Checkout/1.0',
        access_token: apiKey(),
      },
      // GET com body nao vazio retorna 403 no Asaas.
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new AsaasError(504, [{ description: 'Timeout ao falar com o Asaas.' }]);
    throw err;
  }
  clearTimeout(timer);

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* resposta nao-JSON */ }

  if (!res.ok) throw new AsaasError(res.status, json?.errors, text);
  return json;
}

export const asaas = {
  /** Reaproveita o cliente pelo CPF/CNPJ em vez de duplicar cadastro a cada pedido. */
  async findOrCreateCustomer({ name, cpfCnpj, email, mobilePhone, postalCode, addressNumber }) {
    const found = await request('GET', `/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}&limit=1`);
    if (found?.data?.length) return found.data[0];
    return request('POST', '/customers', {
      name, cpfCnpj, email, mobilePhone, postalCode, addressNumber,
      notificationDisabled: true, // quem fala com o cliente e o Só Armação, nao o Asaas
    });
  },

  createPayment(payload) {
    return request('POST', '/payments', payload);
  },

  /**
   * Cliente pelo id — é daqui que sai o CPF na hora de criar o pedido no
   * Bling (NF-e), já que o banco guarda só o hash.
   */
  getCustomer(id) {
    return request('GET', `/customers/${encodeURIComponent(id)}`);
  },

  getPayment(id) {
    return request('GET', `/payments/${encodeURIComponent(id)}`);
  },

  /**
   * Soma, em centavos, todas as parcelas de um parcelamento.
   * No cartão parcelado o Asaas cria uma cobrança por parcela e o webhook
   * dispara uma vez para cada. O `value` de cada evento é o da parcela, não
   * do pedido — sem somar, toda venda parcelada parece pagamento a menor.
   * Devolve null se não conseguir apurar (o chamador decide o que fazer).
   */
  async somarParcelas(installmentId) {
    try {
      const r = await request('GET', `/payments?installment=${encodeURIComponent(installmentId)}&limit=100`);
      if (!r?.data?.length) return null;
      return r.data.reduce((acc, p) => acc + Math.round(Number(p.value) * 100), 0);
    } catch (e) {
      console.error('[asaas] falha ao somar parcelas:', e.message);
      return null;
    }
  },

  /** encodedImage (base64 PNG), payload (copia e cola), expirationDate */
  getPixQrCode(id) {
    return request('GET', `/payments/${encodeURIComponent(id)}/pixQrCode`);
  },

  tokenizeCreditCard(payload) {
    return request('POST', '/creditCard/tokenizeCreditCard', payload);
  },

  /** Checkout hospedado pelo Asaas (cartao sem passar pelo nosso servidor). */
  createCheckout(payload) {
    return request('POST', '/checkouts', payload);
  },

  _request: request,
};

export function isSandbox() {
  return (process.env.ASAAS_ENV || 'sandbox').toLowerCase() === 'sandbox';
}
