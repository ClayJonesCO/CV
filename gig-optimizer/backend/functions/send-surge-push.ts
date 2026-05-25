// scan-surges — scheduled worker (pg_cron / Cron Trigger, ~every 15 min).
//
// Finds market+platform cells whose demand is jumping in the next hour, then
// pushes a heads-up to subscribed drivers whose apps & market match. This is
// the server-side replacement for the client-only checkSurge() — it delivers
// even when the app is closed. Illustrative; trimmed for clarity.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
webpush.setVapidDetails(
  "mailto:ops@peakr.app",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const SURGE_THRESHOLD = 1.7;   // avg_net of next hour vs this market's typical hour
const RISE_MIN = 0.3;          // must be rising, not already peaked

Deno.serve(async () => {
  const now = new Date();
  const dow = now.getDay();
  const hour = now.getHours();
  const next = (hour + 1) % 24;
  const today = now.toISOString().slice(0, 10);

  // Cells (market, platform) where next hour's demand index jumps.
  // demand_index is precomputed during aggregation (avg_net normalized to the
  // market's all-hours average); shown here as a conceptual query.
  const { data: surging } = await supabase.rpc("surging_cells", {
    p_dow: dow, p_hour: hour, p_next: next,
    p_threshold: SURGE_THRESHOLD, p_rise: RISE_MIN,
  });
  if (!surging?.length) return new Response("no surges");

  let sent = 0;
  for (const cell of surging) {            // { market, platform, avg_net }
    // Subscribers in this market who run this platform, alerts on, not quiet hours.
    const { data: devices } = await supabase
      .from("devices")
      .select("id, push_sub, quiet_start, quiet_end")
      .eq("market", cell.market).eq("alerts_on", true)
      .contains("platforms", [cell.platform])
      .not("push_sub", "is", null);

    for (const dev of devices ?? []) {
      if (inQuietHours(hour, dev.quiet_start, dev.quiet_end)) continue;

      // Dedupe: one push per device/cell/day.
      const { error: dupe } = await supabase.from("surge_sent").insert({
        device_id: dev.id, market: cell.market, platform: cell.platform,
        on_date: today, hour: next,
      });
      if (dupe) continue;                  // primary-key conflict = already sent

      try {
        await webpush.sendNotification(dev.push_sub, JSON.stringify({
          title: `Surge incoming: ${cell.platform}`,
          body: `Demand jumps around ${fmtHour(next)} — ~$${(cell.avg_net / 100).toFixed(0)}/hr. Get positioned.`,
          icon: "/gig-optimizer/icon.svg",
          tag: `${cell.market}-${cell.platform}-${next}`,
        }));
        sent++;
      } catch (e) {
        // 404/410 → subscription expired; clear it.
        if ((e as { statusCode?: number }).statusCode === 410) {
          await supabase.from("devices").update({ push_sub: null }).eq("id", dev.id);
        }
      }
    }
  }
  return new Response(`pushed ${sent}`);
});

function inQuietHours(h: number, start = 23, end = 7): boolean {
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}
function fmtHour(h: number): string {
  const p = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${p}`;
}
