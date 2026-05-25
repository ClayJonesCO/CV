-- Referral conversion tracking + operator analytics.

-- One row per bonus-link click. The affiliate network calls our postback with
-- the subid when the driver actually signs up, filling converted_at + payout.
create table referral_clicks (
  id           uuid primary key default gen_random_uuid(),
  subid        text unique not null default encode(gen_random_bytes(9), 'hex'),
  driver_id    uuid references drivers(id) on delete set null,
  platform     text not null,
  market       text,
  clicked_at   timestamptz not null default now(),
  converted_at timestamptz,
  payout_cents integer
);
create index on referral_clicks (platform);
create index on referral_clicks (converted_at);

alter table referral_clicks enable row level security;

-- Single-call operator metrics: usage + referral funnel.
create or replace function admin_analytics()
returns jsonb language sql as $$
  select jsonb_build_object(
    'generated_at', now(),
    'drivers',       (select count(*) from drivers),
    'accounts',      (select count(*) from drivers where email is not null),
    'sessions',      (select count(*) from sessions),
    'sessions_7d',   (select count(*) from sessions where created_at > now() - interval '7 days'),
    'clicks',        (select count(*) from referral_clicks),
    'conversions',   (select count(*) from referral_clicks where converted_at is not null),
    'revenue_cents', (select coalesce(sum(payout_cents),0) from referral_clicks where converted_at is not null),
    'by_platform', (
      select coalesce(jsonb_agg(p order by p.clicks desc), '[]'::jsonb) from (
        select platform,
               count(*)::int as clicks,
               count(*) filter (where converted_at is not null)::int as conversions,
               coalesce(sum(payout_cents) filter (where converted_at is not null), 0)::int as revenue_cents
        from referral_clicks group by platform
      ) p),
    'top_markets', (
      select coalesce(jsonb_agg(m order by m.sessions desc), '[]'::jsonb) from (
        select market, count(*)::int as sessions, count(distinct driver_id)::int as drivers
        from sessions group by market limit 8
      ) m)
  );
$$;
