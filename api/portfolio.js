// ============================================================
// POST /api/portfolio?secret=YOUR_SECRET
//
// Receives a portfolio snapshot from whatever you're using to push
// one (a broker's automation, a scheduled script, a shortcut, ...)
// and overwrites the single latest snapshot into the same Supabase
// app_state table the rest of the dashboard already uses (row key =
// 'portfolio_summary'). Unlike api/apple-health.js, there's no
// history/time-series to merge — we only ever care about the most
// recent portfolio state, so each POST just replaces the row.
//
// Expected JSON body:
//   {
//     "portfolio_value": number,
//     "day_change_pct": number,
//     "day_change_usd": number,
//     "open_positions": number,
//     "alerts_count": number,
//     "alerts_note": string | null,
//     "synced_at": ISO timestamp string
//   }
//
// Set PORTFOLIO_SECRET in Vercel's project env vars (any random
// string) — this endpoint rejects requests that don't send the
// matching `secret` so randoms can't write into your row.
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secretEnv = process.env.PORTFOLIO_SECRET || '';
  const secretGiven = (req.query && req.query.secret) || req.headers['x-secret'] || '';
  if (!secretEnv || secretGiven !== secretEnv) {
    return res.status(401).json({ error: 'missing or invalid secret' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  // Uses the SERVICE ROLE key (server-only) rather than the anon key —
  // the anon key no longer has any RLS access to app_state at all.
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'expected a JSON body with portfolio fields' });
  }

  // Pull whatever's already stored so a partial payload (e.g. a script
  // that only sends a couple of fields) merges over the last snapshot
  // instead of blanking out the rest of it.
  let existing = {};
  try {
    const er = await fetch(SUPABASE_URL + '/rest/v1/app_state?key=eq.portfolio_summary&select=data', {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY },
    });
    if (er.ok) {
      const rows = await er.json();
      if (rows && rows[0] && rows[0].data) existing = rows[0].data;
    }
  } catch (e) { /* fall back to an empty snapshot if the read fails */ }

  const payload = {
    portfolio_value: body.portfolio_value != null ? body.portfolio_value : existing.portfolio_value,
    day_change_pct: body.day_change_pct != null ? body.day_change_pct : existing.day_change_pct,
    day_change_usd: body.day_change_usd != null ? body.day_change_usd : existing.day_change_usd,
    open_positions: body.open_positions != null ? body.open_positions : existing.open_positions,
    alerts_count: body.alerts_count != null ? body.alerts_count : existing.alerts_count,
    alerts_note: body.alerts_note !== undefined ? body.alerts_note : (existing.alerts_note != null ? existing.alerts_note : null),
    synced_at: body.synced_at || new Date().toISOString(),
  };

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key: 'portfolio_summary', data: payload, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'supabase upsert failed', detail: t });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'upsert failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
