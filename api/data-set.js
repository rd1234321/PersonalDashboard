// ============================================================
// POST /api/data-set  { key, data }
// Session-gated upsert into the `app_state` table, using the SERVICE
// ROLE key server-side. Counterpart to api/data-get.js — see that
// file's comment for why this exists instead of a direct client call.
// ============================================================
import { verifySession } from './_session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!verifySession(req)) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const key = body && body.key;
  const data = body ? body.data : undefined;
  if (!key || data === undefined) return res.status(400).json({ error: 'key and data required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server' });
  }

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return res.status(502).json({ error: 'supabase write failed: ' + (await r.text()) });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'write failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
