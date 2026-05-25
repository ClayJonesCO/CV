# Peakr backend — architecture sketch

This folder is a **design sketch**, not a running service. It describes the
backend that turns Peakr's currently-simulated layers into real ones:

- the **data flywheel** (pool anonymized driver-reported earnings → a shared,
  per-market demand model),
- **cross-device sync** of a driver's log/expenses/settings,
- **server-computed surge push** notifications (fire even when the app is closed),
- **forecast + events proxy** (hide API keys, add CORS, cache), and
- **referral** links + conversion tracking (the monetization path).

The static front end (`gig-optimizer/`) stays exactly as is and becomes a client
of this API; it already degrades gracefully to seeded data when offline, so the
backend can roll out incrementally.

---

## 1. Recommended stack

**v1 — Supabase** (fastest path; one platform covers most needs):

| Need | Supabase piece |
|---|---|
| Database | Postgres |
| Auth (anon + email magic link) | Supabase Auth |
| Per-row access control | Row-Level Security (RLS) |
| API / business logic | Edge Functions (Deno/TypeScript) |
| Scheduled aggregation & push | `pg_cron` + Edge Functions |
| Object cache (forecast/events) | a `cache` table or Upstash Redis |

**Scale path — Cloudflare** (cheapest at high volume, runs at the edge):
Workers + D1/Postgres (Hyperdrive) + Queues + Cron Triggers + KV. Same schema,
same API contract; swap the runtime.

Web Push uses VAPID via the `web-push` library (Node) or a Deno-compatible port.

Everything below is stack-neutral: a Postgres schema, a REST contract
(`openapi.yaml`), and two example handlers (`functions/`).

---

## 2. Data flow (the flywheel)

```
 Driver logs a session in the app
        │  POST /v1/sessions   (date, platform, market, geohash5, hours, gross, miles)
        ▼
 sessions (raw, per-driver, RLS-protected)
        │  pg_cron: every hour
        ▼
 aggregate_market_stats()   ── trims outliers, enforces k-anonymity (n ≥ 5)
        ▼
 market_stats  (anonymous: market × platform × dow × hour → n, avg_net, mult)
        │  GET /v1/market-model?market=nash   (public, cached)
        ▼
 community.js  ← replaces the seeded table; blends with the driver's own logs
```

Every logged session makes the model better for everyone in that market — the
network effect competitors can't copy. Only **aggregates** are ever exposed,
and only for cells with enough contributors to be anonymous.

---

## 3. API surface

Full contract in [`openapi.yaml`](./openapi.yaml). Summary:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/auth/anon` | — | Issue an anonymous device token (zero-friction start) |
| POST | `/v1/auth/email` | — | Magic-link upgrade to a real account (sync across devices) |
| POST | `/v1/sessions` | ✓ | Ingest one or many logged earning sessions |
| GET / DELETE | `/v1/sessions[/:id]` | ✓ | List / remove the driver's own sessions |
| POST/GET/DELETE | `/v1/expenses` | ✓ | Expense + mileage tracker sync |
| GET | `/v1/market-model` | public | Community demand model + confidence for a market |
| GET | `/v1/forecast` | public | Cached weather proxy (Open-Meteo) |
| GET | `/v1/events` | public | Upcoming local events (Ticketmaster/SeatGeek, cached) |
| GET | `/v1/referrals` | public | Live sign-up bonuses + affiliate links |
| POST/DELETE | `/v1/push/subscribe` | ✓ | Register/remove a Web Push subscription + alert prefs |

`market-model` is intentionally back-compatible with today's
`community.js`: it returns a per-platform `{ samples, mult }` summary **and**
optional granular `cells` (per day-of-week/hour) for richer calibration.

---

## 4. Surge push (server-side)

`pg_cron` runs `scan-surges` every ~15 min:

1. For the upcoming 1–2 hours, find `market_stats` cells where demand is
   jumping (rising and above a surge threshold).
2. Join to `push_subscriptions` where the driver's `platforms` intersect the
   surging platform, `market` matches, alerts are on, and it's not quiet hours.
3. Send a Web Push (`web-push` + VAPID), deduped per `(driver, cell)` per day.

This replaces the client-only `checkSurge()` (which only fires while the tab is
open) with true background delivery. See
[`functions/send-surge-push.ts`](./functions/send-surge-push.ts).

---

## 5. Privacy, trust & abuse

- **Opt-in** sharing only; a driver can use Peakr fully without contributing.
- **Coarse geometry**: store a 5-char geohash (~5 km cell), never exact GPS.
- **k-anonymity**: a `market_stats` cell is published only once `n_samples ≥ 5`.
- **Outlier control**: winsorize net $/hr before averaging so a few bad entries
  can't skew a cell.
- **Deletable**: `DELETE /v1/sessions` and account deletion purge raw rows;
  aggregates are recomputed.
- **ToS-safe**: data is *driver-self-reported only*. Peakr never scrapes or
  automates platform accounts — that protects drivers from bans and us from
  legal exposure.
- **Rate limiting** + auth on all writes; bot/outlier detection on ingest.

---

## 6. Client integration (small front-end changes)

```js
// community.js — fetch the real model, fall back to the seed when offline
async function loadCommunityModel(market) {
  try {
    const r = await fetch(`${API}/v1/market-model?market=${market}`, {
      headers: { "x-peakr-device": deviceToken },
    });
    if (r.ok) return await r.json();      // { drivers, byPlatform, cells }
  } catch (_) {}
  return SEEDED[market];                  // current behavior, unchanged
}

// app.js — mirror a logged session to the server (best-effort, offline-queued)
function addLogEntry(entry) { /* ...local... */ syncQueue.push("/v1/sessions", entry); }
```

Offline-first stays intact: `localStorage` is the cache; a small sync queue
flushes writes when back online.

---

## 7. Rollout phases

1. **MVP flywheel** — anon auth, `POST /v1/sessions`, nightly
   `aggregate_market_stats()`, `GET /v1/market-model`. Nashville's flywheel
   becomes real; everything else stays seeded.
2. **Background alerts + live data** — Web Push surge job; forecast/events
   proxies with real API keys.
3. **Accounts & money** — email accounts + cross-device sync; referral
   conversion tracking; basic analytics dashboard.

## 8. Cost sketch

At ~10k MAU the v1 footprint fits Supabase's low tiers: Postgres is tiny (raw
sessions are small rows; aggregates are a few thousand cells per market),
Edge Function calls are cheap, push is free (you run VAPID yourself). The main
cost driver is a paid events API (Ticketmaster/SeatGeek) — cache aggressively.
