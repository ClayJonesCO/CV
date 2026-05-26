-- Peakr — Phase 1 schema (Supabase / Postgres). Runnable.
--
-- Design: Edge Functions use the service-role key and scope every query by the
-- driver resolved from an opaque bearer token (device_tokens). RLS is enabled
-- with NO policies so the anon/public key cannot read these tables directly —
-- all access goes through the functions. Aggregates are served by the `api`
-- function too, so market_stats stays private at the row level.

create extension if not exists pgcrypto;     -- gen_random_uuid(), gen_random_bytes()

-- ---------------------------------------------------------------------------
-- Identity + opaque device tokens (zero-friction anonymous start)
-- ---------------------------------------------------------------------------
create table drivers (
  id          uuid primary key default gen_random_uuid(),
  email       text unique,
  created_at  timestamptz not null default now()
);

create table device_tokens (
  token      text primary key default encode(gen_random_bytes(24), 'hex'),
  driver_id  uuid not null references drivers(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index on device_tokens (driver_id);

-- ---------------------------------------------------------------------------
-- Raw, self-reported data (the flywheel input)
-- ---------------------------------------------------------------------------
create table sessions (
  id              uuid primary key default gen_random_uuid(),
  driver_id       uuid not null references drivers(id) on delete cascade,
  occurred_on     date not null,
  start_hour      smallint not null check (start_hour between 0 and 23),
  hours           numeric(5,2) not null check (hours > 0),
  platform        text not null,
  market          text not null,
  geohash5        text,
  gross_cents     integer not null check (gross_cents >= 0),
  miles           numeric(7,1),
  predicted_cents integer,
  source          text not null default 'manual',
  created_at      timestamptz not null default now()
);
create index on sessions (market, platform, occurred_on);
create index on sessions (driver_id);

create table expenses (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null references drivers(id) on delete cascade,
  spent_on     date not null,
  category     text not null,
  amount_cents integer not null check (amount_cents >= 0),
  created_at   timestamptz not null default now()
);
create index on expenses (driver_id);

create table push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  driver_id     uuid not null references drivers(id) on delete cascade,
  sub           jsonb not null,
  market        text,
  platforms     text[] not null default '{}',
  home_geohash5 text,
  alerts_on     boolean not null default true,
  quiet_start   smallint not null default 23,
  quiet_end     smallint not null default 7,
  created_at    timestamptz not null default now()
);
create index on push_subscriptions (market, alerts_on);

-- ---------------------------------------------------------------------------
-- Published, anonymized community model (served via the api function)
-- ---------------------------------------------------------------------------
create table market_stats (
  market        text not null,
  platform      text not null,
  dow           smallint not null,   -- 0..6, or -1 for the per-platform summary
  hour          smallint not null,   -- 0..23, or -1 for the per-platform summary
  n_samples     integer not null,
  avg_net_cents integer not null,
  p25_cents     integer,
  p75_cents     integer,
  mult          numeric(4,2) not null default 1.0,
  updated_at    timestamptz not null default now(),
  primary key (market, platform, dow, hour)
);

create table market_drivers (
  market     text primary key,
  drivers    integer not null default 0,
  updated_at timestamptz not null default now()
);

create table referrals (
  platform     text not null,
  market       text not null default '*',   -- '*' = nationwide
  amount_cents integer not null,
  url          text not null,
  blurb        text,
  active       boolean not null default true,
  primary key (platform, market)
);

create table surge_sent (   -- dedupe push to one per driver/cell/day
  driver_id uuid not null references drivers(id) on delete cascade,
  market text not null, platform text not null, on_date date not null, hour smallint not null,
  sent_at timestamptz not null default now(),
  primary key (driver_id, market, platform, on_date, hour)
);

-- A normalized view used by aggregation (net≈gross at this stage of the model)
create view session_facts as
select market, platform,
       extract(dow from occurred_on)::int as dow,
       start_hour as hour,
       (gross_cents / nullif(hours,0)) as net_cents_per_hr
from sessions
where hours > 0;

-- ---------------------------------------------------------------------------
-- Aggregation: rebuild the community model from raw sessions.
-- Outlier winsorizing (5th–95th pct) + k-anonymity gate (n >= k).
-- ---------------------------------------------------------------------------
create or replace function aggregate_market_stats(k integer default 5)
returns void language sql as $$
  with bounded as (
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
    having count(*) >= k
  ),
  ins_granular as (
    insert into market_stats (market,platform,dow,hour,n_samples,avg_net_cents,p25_cents,p75_cents,mult,updated_at)
    select market,platform,dow,hour,n,avg_net,p25,p75,1.0, now() from granular
    on conflict (market,platform,dow,hour) do update
      set n_samples=excluded.n_samples, avg_net_cents=excluded.avg_net_cents,
          p25_cents=excluded.p25_cents, p75_cents=excluded.p75_cents, updated_at=now()
    returning 1
  ),
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

create or replace function refresh_market_drivers()
returns void language sql as $$
  insert into market_drivers (market, drivers, updated_at)
  select market, count(distinct driver_id), now() from sessions group by market
  on conflict (market) do update set drivers = excluded.drivers, updated_at = now();
$$;

-- Surging cells for the push job: next hour's avg_net is high and rising.
create or replace function surging_cells(p_dow int, p_hour int, p_next int, p_floor int)
returns table (market text, platform text, avg_net int) language sql as $$
  select n.market, n.platform, n.avg_net_cents
  from market_stats n
  left join market_stats c
    on c.market=n.market and c.platform=n.platform and c.dow=p_dow and c.hour=p_hour
  where n.dow=p_dow and n.hour=p_next
    and n.avg_net_cents >= p_floor
    and n.avg_net_cents > coalesce(c.avg_net_cents,0) * 1.15;
$$;

-- Lock down direct access; Edge Functions use the service role (bypasses RLS).
alter table drivers            enable row level security;
alter table device_tokens      enable row level security;
alter table sessions           enable row level security;
alter table expenses           enable row level security;
alter table push_subscriptions enable row level security;
alter table market_stats       enable row level security;
alter table market_drivers     enable row level security;
alter table referrals          enable row level security;
alter table surge_sent         enable row level security;

-- Seed example referral bonuses (replace with real affiliate programs).
insert into referrals (platform, market, amount_cents, url, blurb) values
  ('spark','*',25000,'https://example.com/ref/spark','Walmart Spark new-driver bonus'),
  ('instacart','*',20000,'https://example.com/ref/instacart','Instacart shopper sign-up bonus'),
  ('uber','*',15000,'https://example.com/ref/uber','Uber Driver guaranteed earnings offer'),
  ('doordash','*',17500,'https://example.com/ref/doordash','DoorDash Dasher sign-up bonus'),
  ('ubereats','*',12000,'https://example.com/ref/ubereats','Uber Eats first-deliveries bonus'),
  ('lyft','*',13000,'https://example.com/ref/lyft','Lyft new-driver earnings guarantee'),
  ('amazonflex','*',10000,'https://example.com/ref/amazonflex','Amazon Flex onboarding bonus')
on conflict do nothing;
