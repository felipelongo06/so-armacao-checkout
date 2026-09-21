import crypto from 'node:crypto';

export function limparDigitos(v) { return String(v || '').replace(/\D/g, ''); }

export function cpfValido(cpf) {
  const c = limparDigitos(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (base, pesoInicial) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(c.slice(0, 9), 10) === Number(c[9]) && dv(c.slice(0, 10), 11) === Number(c[10]);
}

export function emailValido(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());
}

export function telefoneValido(t) {
  const d = limparDigitos(t);
  return d.length === 10 || d.length === 11;
}

export function cepValido(c) { return limparDigitos(c).length === 8; }

/** SHA-256 com salt — o que vai pra UTM/analytics, nunca o CPF cru (LGPD). */
export function hashCpf(cpf) {
  const salt = process.env.CPF_HASH_SALT;
  if (!salt) throw new Error('CPF_HASH_SALT nao configurado.');
  return crypto.createHash('sha256').update(limparDigitos(cpf) + salt).digest('hex');
}

/** Normalizacao exigida pelo Meta CAPI / GA4: trim + lowercase + sha256, sem salt. */
export function hashPII(valor) {
  if (!valor) return undefined;
  return crypto.createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex');
}

/** Comparacao em tempo constante — evita vazar o segredo por timing. */
export function compararSegredo(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function ipDoCliente(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '127.0.0.1';
}
