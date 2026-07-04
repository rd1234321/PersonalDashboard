# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. Apple Health is an optional add-on.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** — the default password is in
[`lock.js`](lock.js) (`var PASSWORD = "qwer"`). Change it to whatever you want.

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

-- The browser uses the ANON key, so allow it to read/write:
alter table public.app_state enable row level security;
create policy "anon full access app_state"
  on public.app_state for all
  to anon using (true) with check (true);

-- Instant cross-device updates:
alter publication supabase_realtime add table public.app_state;
```

### SQL #2 — progress-photo sync (Storage bucket)
Progress photos upload to a Supabase **Storage** bucket called `progress-photos` (only the
image URLs sync through `app_state`). Skip this if you don't need photos to sync across devices.
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

### Connect YOUR Supabase — pick ONE way
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.

**Way A — Vercel env vars (easiest, no code edits):**
In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Redeploy. The app reads these automatically via `/api/config`.

**Way B — edit the files:**
Replace the old URL/key in these files:
- [`sync.js`](sync.js)
- [`topbar.js`](topbar.js)
- [`gym.html`](gym.html)

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

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

## 4. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) Apple Health: install Health Auto Export on your phone, add `APPLE_HEALTH_SECRET`
   in Vercel, point its REST API automation at `/api/apple-health`.
4. Change the password in `lock.js`. Done.
