// scan-surges — scheduled Web Push worker (invoked every ~15 min by pg_cron).
// Finds market+platform cells whose demand jumps next hour and notifies
// subscribed drivers whose apps & market match. Background replacement for the
// client-only checkSurge(); delivers even when the app is closed.
import webpush from "npm:web-push@3";
import { admin, json } from "../_shared/util.ts";

const db = admin();
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@peakr.app",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const SURGE_FLOOR_CENTS = Number(Deno.env.get("SURGE_FLOOR_CENTS") ?? "2500");

function inQuietHours(h: number, start: number, end: number) {
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}
function fmtHour(h: number) {
  const p = h < 12 ? "AM" : "PM"; const hh = h % 12 === 0 ? 12 : h % 12; return `${hh}${p}`;
}

Deno.serve(async () => {
  const now = new Date();
  const dow = now.getDay();
  const hour = now.getHours();
  const next = (hour + 1) % 24;
  const today = now.toISOString().slice(0, 10);

  const { data: surging } = await db.rpc("surging_cells", {
    p_dow: dow, p_hour: hour, p_next: next, p_floor: SURGE_FLOOR_CENTS,
  });
  if (!surging?.length) return json({ surges: 0, sent: 0 });

  let sent = 0;
  for (const cell of surging as { market: string; platform: string; avg_net: number }[]) {
    const { data: subs } = await db.from("push_subscriptions")
      .select("driver_id, sub, quiet_start, quiet_end")
      .eq("market", cell.market).eq("alerts_on", true)
      .contains("platforms", [cell.platform]);

    for (const s of subs ?? []) {
      if (inQuietHours(hour, s.quiet_start, s.quiet_end)) continue;
      const dupe = await db.from("surge_sent").insert({
        driver_id: s.driver_id, market: cell.market, platform: cell.platform, on_date: today, hour: next,
      });
      if (dupe.error) continue;   // PK conflict => already sent today
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({
          title: `Surge incoming: ${cell.platform}`,
          body: `Demand jumps around ${fmtHour(next)} — ~$${(cell.avg_net / 100).toFixed(0)}/hr. Get positioned.`,
          icon: "/gig-optimizer/icon.svg",
          tag: `${cell.market}-${cell.platform}-${next}`,
        }));
        sent++;
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 410) {
          await db.from("push_subscriptions").delete().eq("driver_id", s.driver_id);
        }
      }
    }
  }
  return json({ surges: surging.length, sent });
});
