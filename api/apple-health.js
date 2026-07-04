// ============================================================
// POST /api/apple-health?secret=YOUR_SECRET
//
// Receives a "REST API" automation payload from the Health Auto
// Export iOS app, normalizes whatever metrics it contains into
// { name: { label, units, value, date, points: [{date,value}, ...] } }
// — merging new points into whatever history is already stored so
// the dashboard can chart trends, not just show the latest value —
// and upserts it into the same Supabase app_state table the rest of
// the dashboard already uses (row key = 'apple_health'). health.html
// reads that row the same way it reads everything else — no polling
// of Apple's own servers, because there isn't one: Health data never
// leaves your phone until Health Auto Export pushes it here.
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

// Metrics HealthKit tracks as running totals (steps, energy, distance, ...)
// need their raw samples SUMMED per day. Health Auto Export often sends one
// row per sample (sometimes dozens a day), not one pre-summed row per day —
// averaging or taking "the last sample" on those gives nonsense numbers
// (e.g. "4 steps"). Everything else (heart rate, HRV, weight, ...) is a
// point-in-time reading, so those get averaged per day instead.
const SUM_METRICS = new Set([
  'step_count', 'active_energy', 'basal_energy_burned', 'flights_climbed',
  'apple_exercise_time', 'apple_stand_time', 'apple_stand_hour',
  'distance_walking_running', 'distance_cycling', 'distance_swimming',
  'swimming_stroke_count', 'push_count', 'dietary_energy', 'water',
]);

function dayKey(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(dateStr);
  if (m) return m[1];
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Collapse however many raw samples came in per day down to one point per
// day — summed for running-total metrics, averaged for everything else.
function aggregateByDay(rawPoints, sum) {
  const byDay = new Map();
  for (const p of rawPoints) {
    const key = dayKey(p.date);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p.value);
  }
  const out = [];
  for (const [day, vals] of byDay.entries()) {
    const value = sum ? vals.reduce((a, b) => a + b, 0) : vals.reduce((a, b) => a + b, 0) / vals.length;
    out.push({ date: day, value });
  }
  return out;
}

// Merge newly-received points into whatever history is already
// stored for this metric, de-duped by date, capped to the most
// recent 60 so the row doesn't grow without bound.
function mergeHistory(existingPoints, incomingPoints) {
  const byDate = new Map();
  (existingPoints || []).forEach(p => { if (p && p.date) byDate.set(p.date, p.value); });
  incomingPoints.forEach(p => byDate.set(p.date, p.value));
  return Array.from(byDate.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-60);
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
  const metrics = (body && body.data && Array.isArray(body.data.metrics)) ? body.data.metrics : [];
  if (!metrics.length) {
    return res.status(400).json({ error: 'no metrics found in payload (expected body.data.metrics[])' });
  }

  // Pull whatever's already stored so we can merge history in,
  // rather than clobbering yesterday's points with today's payload.
  let existingMetrics = {};
  try {
    const er = await fetch(SUPABASE_URL + '/rest/v1/app_state?key=eq.apple_health&select=data', {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY },
    });
    if (er.ok) {
      const rows = await er.json();
      if (rows && rows[0] && rows[0].data && rows[0].data.metrics) existingMetrics = rows[0].data.metrics;
    }
  } catch (e) { /* fall back to empty history if the read fails */ }

  const summary = {};
  for (const m of metrics) {
    if (!m || !m.name || !Array.isArray(m.data) || !m.data.length) continue;
    const rawPoints = m.data
      .map(p => ({ date: p && p.date, value: pickValue(p) }))
      .filter(p => p.date && p.value != null);
    if (!rawPoints.length) continue;
    const incomingPoints = aggregateByDay(rawPoints, SUM_METRICS.has(m.name));
    if (!incomingPoints.length) continue;
    const prior = existingMetrics[m.name];
    const points = mergeHistory(prior && prior.points, incomingPoints);
    const latest = points[points.length - 1];
    summary[m.name] = {
      label: friendlyLabel(m.name),
      units: m.units || (prior && prior.units) || '',
      value: Math.round(latest.value * 100) / 100,
      date: latest.date,
      points,
    };
  }
  // Keep metrics that already had data but weren't in this particular
  // payload (e.g. you only enabled a subset of metrics for this sync).
  for (const name of Object.keys(existingMetrics)) {
    if (!summary[name]) summary[name] = existingMetrics[name];
  }

  const payload = { updatedAt: new Date().toISOString(), metrics: summary };

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
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
