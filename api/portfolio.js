// ============================================================
// POST /api/portfolio?secret=YOUR_SECRET
//
// Receives a portfolio snapshot from whatever you're using to push
// one (a broker's automation, a scheduled script, a shortcut, ...)
// and upserts it into the same Supabase app_state table the rest of
// the dashboard already uses (row key = 'portfolio_summary'). Most
// fields (value, change, positions, ...) are always the latest snapshot
// — no merge — but portfolio_value also gets appended to a day-bucketed
// value_history (same approach as api/apple-health.js) so the dashboard
// can chart a real trend instead of faking one from a single number.
//
// Expected JSON body:
//   {
//     "portfolio_value": number,
//     "day_change_pct": number,
//     "day_change_usd": number,
//     "open_positions": number,
//     "alerts_count": number,
//     "alerts_note": string | null,
//     "synced_at": ISO timestamp string,
//     "positions": [                         (optional)
//       { "symbol": string, "qty": number, "entry_price": number,
//         "current_price": number, "pnl_pct": number }, ...
//     ]
//   }
//
// Each position's current_price is also appended to a per-symbol
// day-bucketed positions_history (dropped for symbols no longer in the
// latest positions array), so each row can get its own real trend chart.
//
// Like the rest of this row, `positions` is read back out only through
// /api/data-get.js's session-gated proxy — never via a direct anon-key
// Supabase query — since app_state has no RLS policy for anon at all.
//
// Set PORTFOLIO_SECRET in Vercel's project env vars (any random
// string) — this endpoint rejects requests that don't send the
// matching `secret` so randoms can't write into your row.
// ============================================================

// Keep only well-formed rows with the expected fields/types — a
// malformed automation payload shouldn't be able to wedge garbage
// (or arbitrarily large objects) into app_state.
function sanitizePositions(positions) {
  if (!Array.isArray(positions)) return null;
  const clean = positions
    .filter(p => p && typeof p === 'object' && typeof p.symbol === 'string' && p.symbol.trim())
    .slice(0, 200) // sane upper bound
    .map(p => ({
      symbol: p.symbol.trim().slice(0, 20),
      qty: typeof p.qty === 'number' ? p.qty : null,
      entry_price: typeof p.entry_price === 'number' ? p.entry_price : null,
      current_price: typeof p.current_price === 'number' ? p.current_price : null,
      pnl_pct: typeof p.pnl_pct === 'number' ? p.pnl_pct : null,
    }));
  return clean;
}

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

  const incomingPositions = sanitizePositions(body.positions);
  const portfolioValue = body.portfolio_value != null ? body.portfolio_value : existing.portfolio_value;

  // One point per calendar day (last sync of the day wins), capped at 60 —
  // same shape/approach as api/apple-health.js's history, so the dashboard
  // can chart a real trend line instead of faking one from a single value.
  const today = new Date().toISOString().slice(0, 10);
  const priorHistory = Array.isArray(existing.value_history) ? existing.value_history : [];
  let valueHistory = priorHistory;
  if (typeof portfolioValue === 'number') {
    const byDay = new Map(priorHistory.map(p => [p.date, p.value]));
    byDay.set(today, portfolioValue);
    valueHistory = Array.from(byDay.entries())
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-60);
  }

  // Same day-bucketed history, but per symbol (current_price each sync) so
  // each position can get its own real trend chart. Only kept for symbols
  // present in the latest positions payload — a closed/removed position's
  // history isn't carried forward indefinitely.
  const priorPositionsHistory = (existing.positions_history && typeof existing.positions_history === 'object')
    ? existing.positions_history : {};
  let positionsHistory = priorPositionsHistory;
  if (incomingPositions && incomingPositions.length) {
    positionsHistory = {};
    for (const pos of incomingPositions) {
      if (typeof pos.current_price !== 'number') {
        if (priorPositionsHistory[pos.symbol]) positionsHistory[pos.symbol] = priorPositionsHistory[pos.symbol];
        continue;
      }
      const prior = Array.isArray(priorPositionsHistory[pos.symbol]) ? priorPositionsHistory[pos.symbol] : [];
      const byDay = new Map(prior.map(p => [p.date, p.value]));
      byDay.set(today, pos.current_price);
      positionsHistory[pos.symbol] = Array.from(byDay.entries())
        .map(([date, value]) => ({ date, value }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-60);
    }
  }

  const payload = {
    portfolio_value: portfolioValue,
    day_change_pct: body.day_change_pct != null ? body.day_change_pct : existing.day_change_pct,
    day_change_usd: body.day_change_usd != null ? body.day_change_usd : existing.day_change_usd,
    open_positions: body.open_positions != null ? body.open_positions : existing.open_positions,
    alerts_count: body.alerts_count != null ? body.alerts_count : existing.alerts_count,
    alerts_note: body.alerts_note !== undefined ? body.alerts_note : (existing.alerts_note != null ? existing.alerts_note : null),
    synced_at: body.synced_at || new Date().toISOString(),
    positions: incomingPositions != null ? incomingPositions : (existing.positions || undefined),
    value_history: valueHistory,
    positions_history: positionsHistory,
  };
  if (payload.positions === undefined) delete payload.positions;

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
