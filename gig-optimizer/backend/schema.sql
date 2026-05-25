-- Peakr backend schema (Postgres / Supabase). Design sketch.
-- Raw per-driver rows are RLS-protected; only aggregates in market_stats are
-- ever exposed publicly, and only once a cell clears the k-anonymity threshold.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table drivers (
  id          uuid primary key default gen_random_uuid(),
  email       text unique,                 -- null until they upgrade from anon
  created_at  timestamptz not null default now()
);

create table devices (
  id            uuid primary key default gen_random_uuid(),
  driver_id     uuid not null references drivers(id) on delete cascade,
  push_sub      jsonb,                      -- Web Push subscription, null if not subscribed
  market        text,                       -- e.g. 'nash'
  platforms     text[] default '{}',        -- e.g. {uber,doordash}
  home_geohash5 text,                        -- ~5km cell for surge targeting
  alerts_on     boolean not null default false,
  quiet_start   smallint default 23,         -- local hour; suppress pushes
  quiet_end     smallint default 7,
  last_seen     timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Raw driver-reported data (the flywheel input). Self-reported only.
-- ---------------------------------------------------------------------------
create table sessions (
  id             uuid primary key default gen_random_uuid(),
  driver_id      uuid not null references drivers(id) on delete cascade,
  occurred_on    date not null,
  start_hour     smallint not null check (start_hour between 0 and 23),
  hours          numeric(5,2) not null check (hours > 0),
  platform       text not null,             -- 'uber','doordash',...
  market         text not null,             -- 'nash',...
  geohash5       text,                       -- coarse location, optional
  gross_cents    integer not null check (gross_cents >= 0),
  miles          numeric(7,1),
  predicted_cents integer,                   -- model's raw prediction at log time
  source         text default 'manual',      -- 'manual' | 'paste' | 'import'
  created_at     timestamptz not null default now()
);
create index on sessions (market, platform, occurred_on);
create index on sessions (driver_id);

-- Derived helpers used by aggregation
create view session_facts as
select
  market, platform,
  extract(dow from occurred_on)::int as dow,         -- 0=Sun
  start_hour as hour,
  (gross_cents / nullif(hours,0)) as net_cents_per_hr -- net≈gross here; refine w/ cost model
from sessions
where hours > 0;

create table expenses (
  id          uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references drivers(id) on delete cascade,
  spent_on    date not null,
  category    text not null,
  amount_cents integer not null check (amount_cents >= 0)
);
create index on expenses (driver_id);

-- ---------------------------------------------------------------------------
-- Published community model (anonymous aggregates). Public-readable.
-- ---------------------------------------------------------------------------
create table market_stats (
  market        text not null,
  platform      text not null,
  dow           smallint not null,           -- 0..6, or -1 for the all-week summary
  hour          smallint not null,           -- 0..23, or -1 for the all-hours summary
  n_samples     integer not null,
  avg_net_cents integer not null,
  p25_cents     integer,
  p75_cents     integer,
  mult          numeric(4,2) not null default 1.0,  -- avg actual / avg predicted
  updated_at    timestamptz not null default now(),
  primary key (market, platform, dow, hour)
);

create table market_drivers (   -- contributor counts for the confidence read
  market      text primary key,
  drivers     integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Reference / cache tables (proxied external data + monetization)
-- ---------------------------------------------------------------------------
create table referrals (
  platform     text not null,
  market       text,                          -- null = nationwide
  amount_cents integer not null,
  url          text not null,
  blurb        text,
  active       boolean not null default true,
  primary key (platform, market)
);

create table events_cache (
  market   text not null,
  on_date  date not null,
  venue    text not null,
  kind     text not null,                      -- concert|sports|convention
  source   text,
  fetched_at timestamptz not null default now(),
  primary key (market, on_date, venue)
);

create table forecast_cache (
  market    text not null,
  on_date   date not null,
  weather_code int,
  tmax_f    int,
  tmin_f    int,
  precip    int,
  fetched_at timestamptz not null default now(),
  primary key (market, on_date)
);

create table surge_sent (   -- dedupe push per driver/cell/day
  device_id uuid not null references devices(id) on delete cascade,
  market text not null, platform text not null, on_date date not null, hour smallint not null,
  sent_at timestamptz not null default now(),
  primary key (device_id, market, platform, on_date, hour)
);

-- ---------------------------------------------------------------------------
-- Aggregation: recompute the community model from raw sessions.
-- Enforces k-anonymity (K) and winsorizes outliers before averaging.
-- Run via pg_cron, e.g.:  select cron.schedule('agg','5 * * * *','select aggregate_market_stats(5)');
-- ---------------------------------------------------------------------------
create or replace function aggregate_market_stats(k integer default 5)
returns void language sql as $$
  -- (a) granular cells: market × platform × dow × hour
  with bounded as (   -- clip net/hr to its 5th–95th pct per cell to tame outliers
    select market, platform, dow, hour, net_cents_per_hr,
           percentile_cont(0.05) within group (order by net_cents_per_hr)
             over (partition by market,platform,dow,hour) as lo,
           percentile_cont(0.95) within group (order by net_cents_per_hr)
             over (partition by market,platform,dow,hour) as hi
    from session_facts
  ),
  granular as (
    select market, platform, dow, hour,
           count(*) as n,
           avg(least(greatest(net_cents_per_hr,lo),hi))::int as avg_net,
           percentile_cont(0.25) within group (order by net_cents_per_hr)::int as p25,
           percentile_cont(0.75) within group (order by net_cents_per_hr)::int as p75
    from bounded group by 1,2,3,4
    having count(*) >= k                     -- k-anonymity gate
  ),
  ins_granular as (
    insert into market_stats (market,platform,dow,hour,n_samples,avg_net_cents,p25_cents,p75_cents,mult,updated_at)
    select market,platform,dow,hour,n,avg_net,p25,p75,1.0, now() from granular
    on conflict (market,platform,dow,hour) do update
      set n_samples=excluded.n_samples, avg_net_cents=excluded.avg_net_cents,
          p25_cents=excluded.p25_cents, p75_cents=excluded.p75_cents, updated_at=now()
    returning 1
  ),
  -- (b) per-platform summary row (dow=-1, hour=-1) with the calibration mult
  --     = avg actual gross / avg predicted gross (how optimistic the model is)
  summary as (
    select market, platform,
           count(*) as n,
           avg(gross_cents / nullif(hours,0))::int as avg_net,
           round(sum(gross_cents)::numeric / nullif(sum(predicted_cents),0), 2) as mult
    from sessions where hours > 0
    group by market, platform
    having count(*) >= k
  )
  insert into market_stats (market,platform,dow,hour,n_samples,avg_net_cents,mult,updated_at)
  select market,platform,-1,-1,n,avg_net, coalesce(mult,1.0), now() from summary
  on conflict (market,platform,dow,hour) do update
    set n_samples=excluded.n_samples, avg_net_cents=excluded.avg_net_cents,
        mult=excluded.mult, updated_at=now();
$$;

-- Refresh contributor counts for the confidence read (distinct drivers/market).
create or replace function refresh_market_drivers()
returns void language sql as $$
  insert into market_drivers (market, drivers, updated_at)
  select market, count(distinct driver_id), now() from sessions group by market
  on conflict (market) do update
    set drivers = excluded.drivers, updated_at = now();
$$;

-- RLS sketch: drivers see only their own raw rows; aggregates are public.
alter table sessions enable row level security;
alter table expenses enable row level security;
create policy own_sessions on sessions using (driver_id = auth.uid());
create policy own_expenses on expenses using (driver_id = auth.uid());
-- market_stats / market_drivers / referrals: grant select to anon role.
