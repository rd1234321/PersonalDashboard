// ============================================================
// POST /api/session-login  { password }
// Checks the password server-side against DASHBOARD_PASSWORD and, on
// a match, sets a signed httpOnly session cookie. This replaces the
// old lock.js, which only ever compared the password in client-side
// JS (meaning the "protection" was cosmetic — anyone could read the
// plaintext password out of the page source).
// ============================================================
import { makeSessionCookie } from './_session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return res.status(500).json({ ok: false, error: 'DASHBOARD_PASSWORD not configured on the server' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const given = (body && body.password) || '';
  if (given !== pass) return res.status(401).json({ ok: false, error: 'wrong password' });

  res.setHeader('Set-Cookie', makeSessionCookie());
  return res.status(200).json({ ok: true });
}
