-- Scheduled jobs. Requires the pg_cron and pg_net extensions, which on Supabase
-- are enabled from Dashboard → Database → Extensions (or the statements below).
-- Run this migration AFTER those extensions are enabled.
--
-- Replace <PROJECT_REF> and the service-role bearer with your project's values,
-- or store them in Vault and reference them. The aggregation job is pure SQL so
-- it runs in-database; scan-surges is an Edge Function invoked over HTTP.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Rebuild the community model every hour at :05, then refresh driver counts.
select cron.schedule('peakr-aggregate', '5 * * * *', $$
  select aggregate_market_stats(5);
  select refresh_market_drivers();
$$);

-- Fire the surge-push worker every 15 minutes.
select cron.schedule('peakr-scan-surges', '*/15 * * * *', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/scan-surges',
    headers := jsonb_build_object(
                 'Content-Type','application/json',
                 'Authorization','Bearer <SERVICE_ROLE_KEY>'),
    body    := '{}'::jsonb
  );
$$);

-- To remove:  select cron.unschedule('peakr-aggregate');
--             select cron.unschedule('peakr-scan-surges');
