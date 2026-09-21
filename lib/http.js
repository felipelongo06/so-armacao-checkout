/** CORS restrito + rate limit simples. */

function origensPermitidas() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function aplicarCors(req, res) {
  const origin = req.headers.origin;
  const permitidas = origensPermitidas();

  // O preview do Claude Design roda em iframe sandbox e manda `Origin: null`.
  // Pra testar de la, ponha CORS_LIBERADO=true (SO em sandbox — nunca em producao).
  const liberado = process.env.CORS_LIBERADO === 'true' || permitidas.includes('*');

  if (liberado) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && permitidas.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  if (!liberado && origin && permitidas.length && !permitidas.includes(origin)) {
    res.status(403).json({ erro: 'Origem nao autorizada.' });
    return true;
  }
  return false;
}

// Rate limit em memoria. Serve pra conter abuso trivial; a instancia serverless
// e efemera, entao para rigor real troque por Upstash Redis / Vercel KV.
const baldes = new Map();
export function rateLimit(chave, { max = 10, janelaMs = 60_000 } = {}) {
  const agora = Date.now();
  const balde = baldes.get(chave)?.filter((t) => agora - t < janelaMs) || [];
  if (balde.length >= max) return false;
  balde.push(agora);
  baldes.set(chave, balde);
  if (baldes.size > 5000) baldes.clear();
  return true;
}

export function apenasMetodo(req, res, metodo) {
  if (req.method !== metodo) { res.status(405).json({ erro: 'Metodo nao permitido.' }); return true; }
  return false;
}
