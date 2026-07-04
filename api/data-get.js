// ============================================================
// GET /api/data-get?key=<row key>
// Session-gated read of one row from the `app_state` table, using the
// SERVICE ROLE key server-side (never shipped to the browser). This is
// what supabase-shim.js calls instead of letting the client talk to
// Supabase directly with the public anon key — the anon key no longer
// has any RLS access to app_state at all (see SETUP.md).
//
// Special case: when key === 'portfolio_summary', the stored positions'
// current_price/pnl_pct (and the top-level portfolio_value/day_change_*)
// are last known values from whenever api/portfolio.js was last POSTed
// to. Before returning, we layer LIVE prices from Finnhub on top of
// that stored snapshot for display — nothing is written back to
// Supabase here, this only affects what this response returns.
// ============================================================
import { verifySession } from './_session.js';

const FINNHUB_QUOTE_URL = 'https://finnhub.io/api/v1/quote';
const QUOTE_CACHE_MS = 60 * 1000; // avoid hammering Finnhub on repeated dashboard refreshes
const quoteCache = new Map(); // symbol -> { ts, quote } — best-effort, per warm serverless instance

async function fetchLiveQuote(symbol, apiKey) {
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_MS) return cached.quote;

  const url = FINNHUB_QUOTE_URL + '?symbol=' + encodeURIComponent(symbol) + '&token=' + apiKey;
  const r = await fetch(url);
  if (!r.ok) throw new Error('finnhub http ' + r.status);
  const q = await r.json();
  // Finnhub returns { c: current, d: change, dp: percent change, pc: prev close, ... }.
  // c === 0 with no other fields usually means an unrecognized/unsupported symbol.
  if (!q || typeof q.c !== 'number' || q.c === 0) throw new Error('no quote for ' + symbol);
  quoteCache.set(symbol, { ts: Date.now(), quote: q });
  return q;
}

// Enriches a portfolio_summary payload with live Finnhub prices. Falls
// back to the stored current_price/pnl_pct per-position (price_source:
// 'cached') whenever Finnhub isn't configured or a lookup fails, so one
// bad symbol or an outage never breaks the rest of the display.
async function enrichPortfolioWithLiveQuotes(data) {
  if (!data || !Array.isArray(data.positions) || !data.positions.length) return data;

  const apiKey = process.env.FINNHUB_API_KEY;
  const enrichedPositions = await Promise.all(data.positions.map(async (pos) => {
    if (!pos || typeof pos.symbol !== 'string') return pos;
    if (!apiKey) return Object.assign({}, pos, { price_source: 'cached' });
    try {
      const quote = await fetchLiveQuote(pos.symbol, apiKey);
      const livePrice = quote.c;
      const entry = typeof pos.entry_price === 'number' ? pos.entry_price : null;
      const livePnlPct = entry ? ((livePrice - entry) / entry) * 100 : pos.pnl_pct;
      return Object.assign({}, pos, {
        current_price: livePrice,
        pnl_pct: livePnlPct,
        price_source: 'live',
        _day_change: quote.d,   // per-share $ change today — used for the top-level recompute below, stripped before returning
        _day_change_pct: quote.dp,
      });
    } catch (e) {
      return Object.assign({}, pos, { price_source: 'cached' });
    }
  }));

  // Recompute the top-level snapshot from live prices — only if every
  // position has enough data (qty + a price) to make that math real,
  // otherwise leave the last-synced top-level numbers alone rather than
  // publish a partially-live, partially-stale total as if it were exact.
  const canRecompute = enrichedPositions.every(p => typeof p.qty === 'number' && typeof p.current_price === 'number');
  let portfolioValue = data.portfolio_value;
  let dayChangePct = data.day_change_pct;
  let dayChangeUsd = data.day_change_usd;
  if (canRecompute && enrichedPositions.length) {
    portfolioValue = enrichedPositions.reduce((sum, p) => sum + p.qty * p.current_price, 0);
    const liveOnly = enrichedPositions.filter(p => p.price_source === 'live' && typeof p._day_change === 'number');
    if (liveOnly.length === enrichedPositions.length) {
      dayChangeUsd = liveOnly.reduce((sum, p) => sum + p.qty * p._day_change, 0);
      const priorValue = portfolioValue - dayChangeUsd;
      dayChangePct = priorValue ? (dayChangeUsd / priorValue) * 100 : 0;
    }
  }

  const positions = enrichedPositions.map(p => {
    const clean = Object.assign({}, p);
    delete clean._day_change;
    delete clean._day_change_pct;
    return clean;
  });

  return Object.assign({}, data, {
    positions,
    portfolio_value: portfolioValue,
    day_change_pct: dayChangePct,
    day_change_usd: dayChangeUsd,
  });
}

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
    let data = rows && rows[0] ? rows[0].data : null;

    if (key === 'portfolio_summary' && data) {
      data = await enrichPortfolioWithLiveQuotes(data);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(500).json({ error: 'read failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
