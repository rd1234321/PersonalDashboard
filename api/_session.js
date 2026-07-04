// ============================================================
// Shared helper for the dashboard's server-verified login session.
// Filename starts with `_` so Vercel does NOT expose this as its own
// route — it's only ever imported by the other api/*.js files.
//
// Session token = "<issuedAtMs>.<hmacHex>" where hmacHex is an
// HMAC-SHA256 of issuedAtMs keyed by SESSION_SECRET. Stateless (no
// server-side session store needed) and can't be forged without
// SESSION_SECRET, which never leaves the server.
// ============================================================
import crypto from 'crypto';

const COOKIE_NAME = 'dash_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function makeSessionCookie() {
  const secret = process.env.SESSION_SECRET || '';
  const issuedAt = String(Date.now());
  const token = issuedAt + '.' + sign(issuedAt, secret);
  return COOKIE_NAME + '=' + token + '; Max-Age=' + MAX_AGE_SECONDS + '; Path=/; HttpOnly; Secure; SameSite=Lax';
}

export function clearSessionCookie() {
  return COOKIE_NAME + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

export function verifySession(req) {
  const secret = process.env.SESSION_SECRET || '';
  if (!secret) return false;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const issuedAt = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(issuedAt, secret);
  if (expected.length !== sig.length) return false;
  let ok;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (e) {
    return false;
  }
  if (!ok) return false;
  const age = Date.now() - Number(issuedAt);
  return age >= 0 && age <= MAX_AGE_SECONDS * 1000;
}
