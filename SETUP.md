# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. Apple Health is an optional add-on.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** ([`lock.js`](lock.js)) that calls
`/api/session-login` — the password itself lives server-side in an env var (see below), never
in the code, so it can't be read out of the page source.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run **both** SQL blocks in
**SQL Editor → New query → Run**.

### SQL #1 — `app_state` (all dashboard sync)
```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS is on with NO policy for anon — the anon key (public, shipped to
-- the browser) has zero access to this table. All reads/writes go
-- through this app's own /api/data-get and /api/data-set, which use
-- the SERVICE ROLE key server-side and are gated by your dashboard
-- password (see step 1). Don't add an "anon full access" policy here —
-- that's what used to make this table readable/writable by anyone who
-- extracted the anon key from the page source.
alter table public.app_state enable row level security;
```

### SQL #2 — progress-photo sync (Storage bucket)
Progress photos upload to a Supabase **Storage** bucket called `progress-photos` (only the
image URLs sync through `app_state`). Skip this if you don't need photos to sync across devices.
Photo URLs are unguessable but public-by-design (that's how Supabase Storage public buckets
work), which is a much smaller exposure than the whole `app_state` table — so this one still
uses the anon key directly, unlike `app_state` above.
```sql
insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', true)
on conflict (id) do nothing;

create policy "anon manage progress-photos"
  on storage.objects for all
  to anon
  using (bucket_id = 'progress-photos')
  with check (bucket_id = 'progress-photos');
```

### Connect YOUR Supabase
Supabase → **Project Settings → API**. Copy the **Project URL**, the **anon / publishable**
key, and the **service_role** key (further down the same page, behind a "reveal" click).

In Vercel → **Settings → Environment Variables**, add all of these, then redeploy:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key (used client-side, for Storage only) |
| `SUPABASE_SERVICE_ROLE_KEY` | your **service_role** key — **server-only, never expose this** |
| `SESSION_SECRET` | any long random string, e.g. `openssl rand -hex 32` |
| `DASHBOARD_PASSWORD` | whatever password you want to log in with |

The app reads `SUPABASE_URL`/`SUPABASE_ANON_KEY` automatically via `/api/config`; the other
three are read directly by the `/api/*` serverless functions and never sent to the browser.

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security entirely — treat it like a root
> password. It must only ever live in Vercel env vars, never in a file that gets committed or
> a variable that ships to the client.

---

## 3. Apple Health / Apple Watch (optional)

Apple doesn't offer a cloud API for Health data (it lives on your phone by design), so this
works the opposite way from WHOOP: instead of the dashboard pulling from Apple, your phone
**pushes** to the dashboard on a schedule.

1. Install **Health Auto Export – JSON+CSV** from the App Store (free tier works fine).
2. In Vercel → **Settings → Environment Variables**, add one secret and redeploy:

| Variable | Value |
|---|---|
| `APPLE_HEALTH_SECRET` | any random string you make up, e.g. `openssl rand -hex 16` |

3. In the app: **Automations → + → REST API**.
   - **URL**: `https://your-app.vercel.app/api/apple-health?secret=YOUR_APPLE_HEALTH_SECRET`
   - **Method**: `POST`, **Body format**: `JSON`
   - Turn on whichever metrics you want (steps, resting heart rate, HRV, sleep, VO2 max,
     active energy, blood oxygen, weight, ...). Anything you enable shows up on the Health
     page automatically — nothing in the code needs to change per metric.
   - Set the automation to run on a schedule (e.g. daily, or whenever the Health app updates).
4. Run the automation once manually to test, then check the **Health** page — the Apple
   Health card fills in once the first payload lands in Supabase.

> This reuses the same `app_state` table as everything else (row key `apple_health`), so no
> extra Supabase setup is needed beyond the SQL in step 2 above.

> ⚠️ **If the automation gets a `401 Protected deployment` error:** your Vercel project has
> **Deployment Protection** (Vercel Authentication) turned on, which blocks the phone's request
> before it reaches this code — this is separate from the `lock.js` password screen. Go to
> **Settings → Deployment Protection** and set it to **Disabled** (the `lock.js` screen already
> gates the actual pages, so this second layer is usually redundant and just breaks webhooks
> like this one). Redeploy isn't required for this setting.

---

## 4. Portfolio snapshot (optional)

Same pattern as Apple Health: instead of the dashboard polling a brokerage API, something you
control (a broker's automation, a scheduled script, a Shortcut, ...) **pushes** the latest
snapshot to the dashboard whenever it runs.

1. In Vercel → **Settings → Environment Variables**, add one secret and redeploy:

| Variable | Value |
|---|---|
| `PORTFOLIO_SECRET` | any random string you make up, e.g. `openssl rand -hex 16` — **server-only, never expose this** |

2. POST a JSON body to `https://your-app.vercel.app/api/portfolio?secret=YOUR_PORTFOLIO_SECRET`:
   ```json
   {
     "portfolio_value": 128450.32,
     "day_change_pct": 1.24,
     "day_change_usd": 1573.10,
     "open_positions": 14,
     "alerts_count": 0,
     "alerts_note": null,
     "synced_at": "2026-07-04T13:00:00Z"
   }
   ```
   Most fields are always the latest snapshot (a partial payload merges over whatever was
   already there), except `portfolio_value`, which also gets appended to a day-bucketed history
   so the Finance page can chart a real trend line.
3. Once a snapshot lands, a "portfolio ±X% today" segment appears in Finance's ticker and a
   teaser tile + trend chart fill in — both stay hidden until the first snapshot arrives, and
   hide again gracefully if a later read ever fails.

> This reuses the same `app_state` table as everything else (row key `portfolio_summary`), so no
> extra Supabase setup is needed beyond the SQL in step 2 above.

---

## 5. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → add `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, and `DASHBOARD_PASSWORD` in Vercel → redeploy.
3. (Optional) Apple Health: install Health Auto Export on your phone, add `APPLE_HEALTH_SECRET`
   in Vercel, point its REST API automation at `/api/apple-health`.
4. (Optional) Portfolio: add `PORTFOLIO_SECRET` in Vercel, POST snapshots to `/api/portfolio`.
5. Open the site, log in with `DASHBOARD_PASSWORD`. Done.

## Upgrading an existing deployment
If you had this dashboard running before this version, your data isn't lost — it's still sitting
in the same `app_state` table. You just need to: run the updated SQL #1 above (drops the old
`anon full access` policy), add the three new env vars (`SUPABASE_SERVICE_ROLE_KEY`,
`SESSION_SECRET`, `DASHBOARD_PASSWORD`) in Vercel, and redeploy. If `api/apple-health.js` was
already set up, it keeps working (it was switched to the service role key too).
