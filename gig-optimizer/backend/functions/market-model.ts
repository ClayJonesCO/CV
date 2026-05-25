// GET /v1/market-model?market=nash  — public, cacheable.
//
// Serves the anonymized community demand model for a market. Shape is
// back-compatible with the front-end's community.js (per-platform
// { samples, mult }) and adds optional granular cells. Illustrative
// Supabase Edge Function (Deno); the same logic ports to a Cloudflare Worker.

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json",
  // Public model is fine to cache at the edge for a few minutes.
  "cache-control": "public, max-age=300",
};

Deno.serve(async (req) => {
  const market = new URL(req.url).searchParams.get("market");
  if (!market) {
    return new Response(JSON.stringify({ error: "market required" }), { status: 400, headers: CORS });
  }

  // Per-platform summary rows are stored with dow=-1, hour=-1.
  const [{ data: summary }, { data: cells }, { data: drivers }] = await Promise.all([
    supabase.from("market_stats")
      .select("platform, n_samples, mult")
      .eq("market", market).eq("dow", -1).eq("hour", -1),
    supabase.from("market_stats")
      .select("platform, dow, hour, n_samples, avg_net_cents")
      .eq("market", market).gte("dow", 0),
    supabase.from("market_drivers").select("drivers").eq("market", market).maybeSingle(),
  ]);

  const byPlatform: Record<string, { samples: number; mult: number }> = {};
  for (const r of summary ?? []) {
    byPlatform[r.platform] = { samples: r.n_samples, mult: Number(r.mult) };
  }

  return new Response(JSON.stringify({
    market,
    drivers: drivers?.drivers ?? 0,
    byPlatform,
    cells: (cells ?? []).map((c) => ({
      platform: c.platform, dow: c.dow, hour: c.hour,
      n: c.n_samples, avg_net: c.avg_net_cents / 100,
    })),
  }), { headers: CORS });
});
