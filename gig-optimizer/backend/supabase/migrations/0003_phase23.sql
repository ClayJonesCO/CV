-- Phase 2 (forecast/events proxy) + Phase 3 (email accounts) tables.

-- Market coordinates the proxy needs server-side (mirrors front-end data.js).
create table markets (
  ref  text primary key,
  name text not null,
  lat  double precision not null,
  lng  double precision not null
);
insert into markets (ref, name, lat, lng) values
  ('nash','Nashville, TN', 36.1627, -86.7816),
  ('nyc','New York City, NY', 40.7128, -74.0060),
  ('la','Los Angeles, CA', 34.0522, -118.2437),
  ('chi','Chicago, IL', 41.8781, -87.6298),
  ('atx','Austin, TX', 30.2672, -97.7431),
  ('atl','Atlanta, GA', 33.7490, -84.3880),
  ('den','Denver, CO', 39.7392, -104.9903)
on conflict do nothing;

-- One-time email codes for account linking / cross-device sync.
create table email_otps (
  email      text primary key,
  code_hash  text not null,
  driver_id  uuid not null references drivers(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table markets    enable row level security;
alter table email_otps enable row level security;

-- Move all of one driver's data onto another, then delete the source driver.
-- Used when a device verifies an email that already belongs to an account.
create or replace function merge_driver(src uuid, dst uuid)
returns void language plpgsql as $$
begin
  if src = dst then return; end if;
  update sessions           set driver_id = dst where driver_id = src;
  update expenses           set driver_id = dst where driver_id = src;
  update push_subscriptions set driver_id = dst where driver_id = src;
  update device_tokens      set driver_id = dst where driver_id = src;
  delete from drivers where id = src;
end;
$$;
