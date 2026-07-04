// ============================================================
// GET /api/data-get?key=<row key>
// Session-gated read of one row from the `app_state` table, using the
// SERVICE ROLE key server-side (never shipped to the browser). This is
// what supabase-shim.js calls instead of letting the client talk to
// Supabase directly with the public anon key — the anon key no longer
// has any RLS access to app_state at all (see SETUP.md).
// ============================================================
import { verifySession } from './_session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  if (!verifySession(req)) return res.status(401).json({ error: 'unauthorized' });

  const key = req.query && req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server' });
  }

  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/app_state?key=eq.' + encodeURIComponent(key) + '&select=data',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!r.ok) return res.status(502).json({ error: 'supabase read failed: ' + (await r.text()) });
    const rows = await r.json();
    const data = rows && rows[0] ? rows[0].data : null;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(500).json({ error: 'read failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
