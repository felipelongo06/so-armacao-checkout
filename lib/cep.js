/**
 * Consulta de CEP no servidor (ViaCEP).
 *
 * Por que no servidor e não no navegador: o endereço alimenta a análise
 * antifraude do cartão e a etiqueta de envio. Endereço vindo do cliente é
 * editável; vindo do CEP consultado aqui, não.
 */

const cache = new Map();
const TTL = 24 * 60 * 60 * 1000;

export async function consultarCep(cep) {
  const limpo = String(cep || '').replace(/\D/g, '');
  if (limpo.length !== 8) return null;

  const emCache = cache.get(limpo);
  if (emCache && Date.now() - emCache.em < TTL) return emCache.dados;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://viacep.com.br/ws/${limpo}/json/`, { signal: controller.signal });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.erro) return null;

    const dados = {
      logradouro: j.logradouro || '',
      bairro: j.bairro || '',
      cidade: j.localidade || '',
      uf: j.uf || '',
    };
    if (cache.size > 2000) cache.clear();
    cache.set(limpo, { em: Date.now(), dados });
    return dados;
  } catch {
    return null; // CEP indisponível nunca derruba o checkout
  } finally {
    clearTimeout(timer);
  }
}
