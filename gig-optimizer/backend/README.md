# Peakr backend — Phase 1 (runnable Supabase project)

This is a deployable Phase-1 backend that turns Peakr's simulated layers real:

- the **data flywheel** — pool anonymized driver-reported sessions into a
  shared, per-market demand model,
- **cross-device sync** of a driver's sessions/expenses,
- **server-computed surge push** (fires even when the app is closed), and
- a **referrals** read for monetization.

The static front end (`gig-optimizer/`) is wired to call this API **behind a
feature flag that is OFF by default**, so the standalone demo and tests are
unaffected until you point it at a real deployment.

## Layout

```
backend/
  README.md                 ← you are here
  openapi.yaml              ← REST contract
  .env.example              ← Edge Function secrets
  supabase/
    migrations/
      0001_init.sql         ← schema, aggregation + surge SQL, RLS, seed
      0002_schedules.sql    ← pg_cron jobs (run after enabling pg_cron/pg_net)
    functions/
      _shared/util.ts       ← CORS, admin client, token→driver resolver
      api/index.ts          ← auth-anon, sessions, expenses, market-model, referrals, push
      aggregate/index.ts    ← manual/scheduled model rebuild
      scan-surges/index.ts  ← Web Push worker
```

## Design

- **Auth:** zero-friction. `POST /auth/anon` mints an opaque bearer token
  (`device_tokens`) tied to a new `drivers` row; the client stores it and sends
  `Authorization: Bearer <token>`. (Email-account upgrade is Phase 3.)
- **Access control:** every table has RLS enabled with **no policies**, so the
  public anon key can't read them. All access goes through Edge Functions using
  the **service-role** key, which scope each query by the token's `driver_id`.
  Public reads (`market-model`, `referrals`) are served by the same function.
- **Flywheel:** raw rows land in `sessions`; `aggregate_market_stats()` rebuilds
  the public model hourly with **outlier winsorizing** and a **k-anonymity gate**
  (a cell is published only once `n_samples ≥ K`). `market-model` returns a
  per-platform `{ samples, mult }` summary (back-compatible with `community.js`)
  plus granular `cells`.
- **Surge push:** `surging_cells()` finds market+platform cells jumping next
  hour; `scan-surges` notifies matching subscribers via Web Push (VAPID), deduped
  per driver/cell/day with quiet-hours suppression.

## Deploy (Phase 1)

```bash
# 0. Prereqs: a Supabase project + the Supabase CLI, linked:
supabase link --project-ref <PROJECT_REF>

# 1. Schema + seed
supabase db push                      # applies migrations/0001_init.sql

# 2. Secrets (VAPID keys for push)
npx web-push generate-vapid-keys      # copy the public/private keys
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:ops@peakr.app K_ANONYMITY=5 SURGE_FLOOR_CENTS=2500
# (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

# 3. Functions
supabase functions deploy api
supabase functions deploy aggregate
supabase functions deploy scan-surges

# 4. Schedules: enable pg_cron + pg_net (Dashboard → Database → Extensions),
#    edit 0002_schedules.sql with your project ref + service-role key, then:
supabase db push                      # applies migrations/0002_schedules.sql
```

Your API base is then `https://<PROJECT_REF>.functions.supabase.co/api`.

## Point the front end at it

The client reads the API base from `window.PEAKR_CONFIG` or a `peakr.apiBase`
localStorage key. Easiest: copy the example and include it before `app.js`.

```bash
cp gig-optimizer/config.example.js gig-optimizer/config.js   # then edit apiBase
```

```html
<!-- in gig-optimizer/index.html, before backend-client.js -->
<script src="config.js"></script>
```

With it set, the app fetches the live `market-model` on load/market-change
(overriding the seed) and mirrors each logged session/expense to the backend.
Unset, every client call is a no-op and the app runs fully standalone.

## Privacy / trust

Self-reported data only — Peakr never scrapes or automates platform accounts.
Coarse geohash (~5 km), k-anonymity before any cell is exposed, outlier
trimming, and full per-driver deletion (`DELETE /sessions`, account deletion).

## Rollout

1. **This package** — flywheel + sync + surge push + referrals.
2. Live forecast/events proxies with real API keys (cache tables included).
3. Email accounts + cross-device merge, referral conversion tracking, analytics.
