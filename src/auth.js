const encoder = new TextEncoder();
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

export const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const randomToken = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export async function hashSecret(value, pepper) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export function createCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
}

export async function sendCodeEmail({ email, code, env, fetcher = fetch }) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) throw new Error('email_unavailable');
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [email], subject: '你的字见登录验证码', html: `<p>你的验证码是 <strong style="font-size:24px;letter-spacing:4px">${code}</strong></p><p>10 分钟内有效，请勿转发。</p>` })
  });
  if (!response.ok) throw new Error('email_unavailable');
}

const readCookie = (request, name) => Object.fromEntries((request.headers.get('cookie') || '').split(';').filter(Boolean).map(item => item.trim().split('=')))[name];

export async function sessionUserId(request, env) {
  const token = readCookie(request, 'zixian_session');
  if (!token || !env.AUTH_PEPPER) return null;
  const tokenHash = await hashSecret(token, env.AUTH_PEPPER);
  const session = await env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP").bind(tokenHash).first();
  return session?.user_id ?? null;
}

export async function createSession(userId, env) {
  const token = randomToken();
  const tokenHash = await hashSecret(token, env.AUTH_PEPPER);
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+365 days'))").bind(crypto.randomUUID(), userId, tokenHash).run();
  return token;
}

export const sessionCookie = token => `zixian_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
export const clearSessionCookie = 'zixian_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
