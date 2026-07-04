// ============================================================
// POST /api/apple-health?secret=YOUR_SECRET
//
// Receives a "REST API" automation payload from the Health Auto
// Export iOS app, normalizes whatever metrics it contains into
// { name: { label, value, units, date } }, and upserts it into the
// same Supabase app_state table the rest of the dashboard already
// uses (row key = 'apple_health'). health.html reads that row the
// same way it reads everything else — no polling of Apple's own
// servers, because there isn't one: Health data never leaves your
// phone until Health Auto Export pushes it here.
//
// Set up on your iPhone:
//   1. Install "Health Auto Export - JSON+CSV" from the App Store.
//   2. Automations -> + -> REST API.
//   3. URL:    https://<your-vercel-domain>/api/apple-health?secret=<APPLE_HEALTH_SECRET>
//      Method: POST      Body format: JSON
//   4. Pick whatever metrics you want synced (steps, resting heart
//      rate, sleep, HRV, VO2 max, active energy, ...). Anything you
//      turn on shows up on the dashboard automatically — nothing
//      here needs to change per metric.
//   5. Set the automation to run automatically (e.g. daily, or on a
//      schedule) so it keeps pushing fresh data.
//
// Also set APPLE_HEALTH_SECRET in Vercel's project env vars (any
// random string) — this endpoint rejects requests that don't send
// the matching `secret` so randoms can't write into your row.
// ============================================================

const FRIENDLY = {
  step_count: 'Steps',
  resting_heart_rate: 'Resting HR',
  heart_rate: 'Heart Rate',
  heart_rate_variability: 'HRV',
  active_energy: 'Active Energy',
  basal_energy_burned: 'Resting Energy',
  vo2_max: 'VO2 Max',
  respiratory_rate: 'Respiratory Rate',
  walking_heart_rate_average: 'Walking HR',
  weight_body_mass: 'Weight',
  body_fat_percentage: 'Body Fat %',
  sleep_analysis: 'Sleep',
  blood_oxygen_saturation: 'Blood Oxygen',
  flights_climbed: 'Flights Climbed',
};

// Health Auto Export's per-point shape varies by metric type — pull
// whichever numeric field is actually present.
function pickValue(point) {
  if (!point || typeof point !== 'object') return null;
  const candidates = ['qty', 'Avg', 'avg', 'value', 'asleep'];
  for (const k of candidates) {
    if (typeof point[k] === 'number') return point[k];
  }
  return null;
}

function friendlyLabel(name) {
  return FRIENDLY[name] || String(name).replace(/_/g, ' ');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secretEnv = process.env.APPLE_HEALTH_SECRET || '';
  const secretGiven = (req.query && req.query.secret) || req.headers['x-secret'] || '';
  if (!secretEnv || secretGiven !== secretEnv) {
    return res.status(401).json({ error: 'missing or invalid secret' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY not configured on the server' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const metrics = (body && body.data && Array.isArray(body.data.metrics)) ? body.data.metrics : [];
  if (!metrics.length) {
    return res.status(400).json({ error: 'no metrics found in payload (expected body.data.metrics[])' });
  }

  const summary = {};
  for (const m of metrics) {
    if (!m || !m.name || !Array.isArray(m.data) || !m.data.length) continue;
    const latest = m.data[m.data.length - 1];
    const value = pickValue(latest);
    if (value == null) continue;
    summary[m.name] = {
      label: friendlyLabel(m.name),
      value: Math.round(value * 100) / 100,
      units: m.units || '',
      date: latest.date || null,
    };
  }

  const payload = { updatedAt: new Date().toISOString(), metrics: summary };

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key: 'apple_health', data: payload, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'supabase upsert failed', detail: t });
    }
    return res.status(200).json({ ok: true, storedMetrics: Object.keys(summary).length });
  } catch (e) {
    return res.status(500).json({ error: 'upsert failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
