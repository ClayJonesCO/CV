# Peakr — deploy runbook

Goes from the static demo to a live, backend-powered app. The front end stays a
plain static site; the backend is a Supabase project. Until you add a
`config.js` (last step), everything runs standalone on seeded data — so you can
deploy the backend and flip it on only when you're ready.

Detailed backend reference: [`backend/README.md`](./backend/README.md).

> **Automated option:** `.github/workflows/deploy.yml` runs all of the steps
> below (backend + GitHub Pages) on demand. After the one-time setup — enable
> Pages with the "GitHub Actions" source and add the repo secrets listed in that
> file — merge this branch so the workflow lands on the default branch, then
> Actions → **Deploy Peakr** → **Run workflow**. The manual steps below are the
> same thing by hand. (I can't trigger it for you: it runs in your repo under
> your account and needs secrets that aren't in this environment.)

---

## 0. Prerequisites

- A [Supabase](https://supabase.com) project (note its **project ref**).
- Supabase CLI + Node 18+ installed.
- Keys to obtain (all optional — features degrade gracefully without them):
  - **VAPID** key pair — push (`npx web-push generate-vapid-keys`).
  - **Ticketmaster Discovery** API key — real events.
  - **Resend** API key — emailed sign-in codes (else codes return as `dev_code`).
  - Pick two secrets yourself: **`ADMIN_KEY`** (analytics dashboard) and
    **`REFERRAL_POSTBACK_SECRET`** (affiliate callback).

## 1. Backend — schema + functions

```bash
cd gig-optimizer/backend
supabase link --project-ref <PROJECT_REF>
supabase db push                       # 0001 + 0003 + 0004 (schema, accounts, tracking)

supabase secrets set \
  K_ANONYMITY=5 SURGE_FLOOR_CENTS=2500 \
  VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:ops@peakr.app \
  TICKETMASTER_API_KEY=... RESEND_API_KEY=... OTP_FROM="Peakr <onboarding@resend.dev>" \
  ADMIN_KEY=... REFERRAL_POSTBACK_SECRET=...
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

supabase functions deploy api
supabase functions deploy aggregate
supabase functions deploy scan-surges
```

## 2. Backend — scheduled jobs

1. Enable **pg_cron** and **pg_net** (Dashboard → Database → Extensions).
2. Edit `supabase/migrations/0002_schedules.sql`: set `<PROJECT_REF>` and the
   service-role bearer in the `scan-surges` HTTP call.
3. `supabase db push` to apply it. (Hourly model rebuild + 15-min surge scan.)

## 3. Monetization wiring

- Replace the example rows in `referrals` (seeded by `0001_init.sql`) with your
  real affiliate links: `update referrals set url = '...' where platform = '...';`
- In each affiliate network, set the **conversion postback** to:
  `POST https://<PROJECT_REF>.functions.supabase.co/api/referrals/postback`
  with header `x-postback-secret: <REFERRAL_POSTBACK_SECRET>` and body
  `{ "subid": "<their macro for our subid>", "payout_cents": <amount> }`.

## 4. Front end — go live

```bash
cd gig-optimizer
cp config.example.js config.js          # set apiBase to https://<PROJECT_REF>.functions.supabase.co/api
```
Add it before `backend-client.js` in `index.html`:
```html
<script src="config.js"></script>
<script src="backend-client.js"></script>
```
Host the `gig-optimizer/` folder anywhere static (e.g. enable GitHub Pages on
this repo → served at `https://<user>.github.io/CV/gig-optimizer/`). The service
worker + manifest make it installable over HTTPS.

## 5. Smoke test (live)

- [ ] App loads with no console errors; footer/hero behave normally.
- [ ] Network tab shows `GET /api/market-model` and `GET /api/forecast` 200s.
- [ ] Log a session → `POST /api/sessions` 201; appears after a reload (synced).
- [ ] "☁ Sync" → email code (or `dev_code`) → verify → log persists on another device.
- [ ] Click a sign-up bonus → `POST /api/referrals/click` → opens a `?subid=…` URL.
- [ ] Fire a test postback (curl) → conversion shows in the dashboard.
- [ ] `admin.html` + admin key → live KPIs load.
- [ ] After `aggregate` runs (or invoke it once), `market-model` reflects real
      sessions once a cell passes the k-anonymity threshold (K=5).

## 6. Rollback / disable

Delete (or don't ship) `config.js` → the app instantly reverts to the standalone
seeded demo. No backend calls, no data leaves the device.
