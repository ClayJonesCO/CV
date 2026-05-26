// aggregate — scheduled rebuild of the community model (also callable manually).
// Pure DB work; the SQL functions do the heavy lifting. Scheduling lives in
// 0002_schedules.sql (pg_cron calls the SQL directly), but exposing it as a
// function is handy for manual re-runs and local testing.
import { admin, json } from "../_shared/util.ts";

const db = admin();

Deno.serve(async () => {
  const k = Number(Deno.env.get("K_ANONYMITY") ?? "5");
  const a = await db.rpc("aggregate_market_stats", { k });
  const d = await db.rpc("refresh_market_drivers");
  if (a.error || d.error) return json({ error: a.error?.message ?? d.error?.message }, 500);
  return json({ ok: true, k });
});
