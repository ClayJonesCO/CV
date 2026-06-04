-- Stripe billing for Pro subscriptions.
--
-- The webhook (POST /billing/webhook, signature-verified) writes here when a
-- checkout completes or a subscription's state changes, and updates drivers.tier
-- accordingly. Tier becomes the server's source of truth for Pro across devices;
-- the client mirrors it via GET /me.

alter table drivers add column if not exists tier       text not null default 'free';
alter table drivers add column if not exists pro_source text;

create table billing_customers (
  driver_id              uuid primary key references drivers(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status                 text,             -- active | trialing | past_due | canceled | unpaid | incomplete
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);
create index on billing_customers (stripe_customer_id);
create index on billing_customers (stripe_subscription_id);

alter table billing_customers enable row level security;
