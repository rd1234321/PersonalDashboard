// ============================================================
// GET /api/session-check
// Used by lock.js on every page load to decide whether to show the
// dashboard or the password prompt.
// ============================================================
import { verifySession } from './_session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: verifySession(req) });
}
