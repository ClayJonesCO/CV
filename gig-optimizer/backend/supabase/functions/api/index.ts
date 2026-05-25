// Peakr API — request/response endpoints (Supabase Edge Function "api").
// Invoked at https://<ref>.functions.supabase.co/api/<endpoint>.
//
// Endpoints:
//   POST   /api/auth/anon                 -> { token }
//   POST   /api/sessions                  (one or array)        [auth]
//   GET    /api/sessions                                        [auth]
//   DELETE /api/sessions?id=...                                 [auth]
//   POST   /api/expenses                                        [auth]
//   GET    /api/expenses                                        [auth]
//   DELETE /api/expenses?id=...                                 [auth]
//   GET    /api/market-model?market=nash  (public)
//   GET    /api/referrals?market=nash     (public)
//   POST   /api/push/subscribe                                  [auth]
//   DELETE /api/push/subscribe                                  [auth]

import { admin, CORS, json, driverFromToken, sha256hex } from "../_shared/util.ts";
import { getForecast, getEvents } from "../_shared/feeds.ts";

const db = admin();

function dollarsToCents(n: unknown): number {
  return Math.round(Number(n) * 100);
}

// Map a client log entry to a sessions row.
function sessionRow(driver_id: string, e: Record<string, unknown>) {
  return {
    driver_id,
    occurred_on: e.date ?? e.occurred_on,
    start_hour: e.startHour ?? e.start_hour ?? 0,
    hours: e.hours,
    platform: e.platform,
    market: e.market,
    geohash5: e.geohash5 ?? null,
    gross_cents: dollarsToCents(e.actualGross ?? e.gross),
    miles: e.miles ?? null,
    predicted_cents: e.predictedGross != null ? dollarsToCents(e.predictedGross) : null,
    source: e.source ?? "manual",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/api/, "");   // strip up to /api

  // ---- public endpoints ----
  if (req.method === "GET" && path === "/market-model") {
    const market = url.searchParams.get("market");
    if (!market) return json({ error: "market required" }, 400);
    const [{ data: summary }, { data: cells }, { data: drv }] = await Promise.all([
      db.from("market_stats").select("platform,n_samples,mult").eq("market", market).eq("dow", -1).eq("hour", -1),
      db.from("market_stats").select("platform,dow,hour,n_samples,avg_net_cents").eq("market", market).gte("dow", 0),
      db.from("market_drivers").select("drivers").eq("market", market).maybeSingle(),
    ]);
    const byPlatform: Record<string, { samples: number; mult: number }> = {};
    for (const r of summary ?? []) byPlatform[r.platform] = { samples: r.n_samples, mult: Number(r.mult) };
    return json({
      market,
      drivers: drv?.drivers ?? 0,
      byPlatform,
      cells: (cells ?? []).map((c) => ({ platform: c.platform, dow: c.dow, hour: c.hour, n: c.n_samples, avg_net: c.avg_net_cents / 100 })),
    }, 200, { "cache-control": "public, max-age=300" });
  }

  if (req.method === "GET" && path === "/referrals") {
    const market = url.searchParams.get("market") ?? "*";
    const { data } = await db.from("referrals").select("platform,amount_cents,url,blurb")
      .eq("active", true).in("market", [market, "*"]);
    return json((data ?? []).map((r) => ({ platform: r.platform, amount: r.amount_cents / 100, url: r.url, blurb: r.blurb })));
  }

  // Affiliate conversion postback (called by the network when a driver signs up).
  // Authenticated by a shared secret, not a device token.
  if (req.method === "POST" && path === "/referrals/postback") {
    if (req.headers.get("x-postback-secret") !== Deno.env.get("REFERRAL_POSTBACK_SECRET")) {
      return json({ error: "forbidden" }, 403);
    }
    const { subid, payout_cents } = await req.json();
    const { error } = await db.from("referral_clicks")
      .update({ converted_at: new Date().toISOString(), payout_cents: payout_cents ?? null })
      .eq("subid", subid).is("converted_at", null);
    return error ? json({ error: error.message }, 400) : json({ ok: true });
  }

  // Operator analytics (usage + referral funnel). Guarded by an admin key.
  if (req.method === "GET" && path === "/admin/analytics") {
    if (req.headers.get("x-admin-key") !== Deno.env.get("ADMIN_KEY")) {
      return json({ error: "forbidden" }, 403);
    }
    const { data, error } = await db.rpc("admin_analytics");
    return error ? json({ error: error.message }, 500) : json(data);
  }

  // 7-day weather + local events, proxied & cached server-side (keys hidden).
  if (req.method === "GET" && (path === "/forecast" || path === "/events")) {
    const market = url.searchParams.get("market");
    if (!market) return json({ error: "market required" }, 400);
    if (path === "/events") return json(await getEvents(db, market), 200, { "cache-control": "public, max-age=1800" });
    const [days, events] = await Promise.all([getForecast(db, market), getEvents(db, market)]);
    for (const d of days) d.event = events[d.date] ?? null;     // merge events onto days
    return json({ source: "live", days }, 200, { "cache-control": "public, max-age=900" });
  }

  // ---- anonymous token issuance ----
  if (req.method === "POST" && path === "/auth/anon") {
    const { data: driver, error: de } = await db.from("drivers").insert({}).select("id").single();
    if (de) return json({ error: de.message }, 500);
    const { data: tok, error: te } = await db.from("device_tokens").insert({ driver_id: driver.id }).select("token").single();
    if (te) return json({ error: te.message }, 500);
    return json({ token: tok.token, driver_id: driver.id }, 201);
  }

  // ---- everything else needs a valid device token ----
  const driver_id = await driverFromToken(db, req);
  if (!driver_id) return json({ error: "unauthorized" }, 401);

  // Record a bonus-link click and hand back the affiliate URL with our subid,
  // so the eventual conversion postback can be attributed.
  if (req.method === "POST" && path === "/referrals/click") {
    const { platform, market } = await req.json();
    const { data: ref } = await db.from("referrals").select("url")
      .eq("platform", platform).eq("active", true).in("market", [market ?? "*", "*"]).limit(1).maybeSingle();
    if (!ref) return json({ error: "no offer" }, 404);
    const { data: click } = await db.from("referral_clicks")
      .insert({ driver_id, platform, market }).select("subid").single();
    const sep = ref.url.includes("?") ? "&" : "?";
    return json({ url: `${ref.url}${sep}subid=${click.subid}` }, 201);
  }

  // Who am I (for showing signed-in state across devices)?
  if (req.method === "GET" && path === "/me") {
    const { data } = await db.from("drivers").select("id,email").eq("id", driver_id).maybeSingle();
    return json({ driver_id, email: data?.email ?? null });
  }

  // Email account: request a one-time code (Phase 3 cross-device sync).
  if (req.method === "POST" && path === "/auth/email") {
    const { email } = await req.json();
    if (!email || !/.+@.+\..+/.test(email)) return json({ error: "valid email required" }, 400);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const code_hash = await sha256hex(`${email}:${code}`);
    const expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
    await db.from("email_otps").upsert({ email, code_hash, driver_id, expires_at });
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (resendKey) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "authorization": `Bearer ${resendKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("OTP_FROM") ?? "Peakr <onboarding@resend.dev>",
          to: email, subject: "Your Peakr sign-in code",
          text: `Your Peakr code is ${code}. It expires in 15 minutes.`,
        }),
      }).catch(() => {});
      return json({ sent: true });
    }
    return json({ sent: true, dev_code: code });   // no email provider configured: dev mode
  }

  // Verify the code; link the email to this driver, merging an existing account.
  if (req.method === "POST" && path === "/auth/verify") {
    const { email, code } = await req.json();
    const { data: otp } = await db.from("email_otps").select("*").eq("email", email).maybeSingle();
    if (!otp || new Date(otp.expires_at) < new Date()) return json({ error: "code expired" }, 400);
    if (otp.code_hash !== await sha256hex(`${email}:${code}`)) return json({ error: "wrong code" }, 400);
    await db.from("email_otps").delete().eq("email", email);

    const { data: existing } = await db.from("drivers").select("id").eq("email", email).maybeSingle();
    let finalDriver = driver_id;
    if (existing && existing.id !== driver_id) {
      // This device verified an email that already owns an account → merge into it.
      await db.rpc("merge_driver", { src: driver_id, dst: existing.id });
      finalDriver = existing.id;
    } else if (!existing) {
      await db.from("drivers").update({ email }).eq("id", driver_id);
    }
    return json({ driver_id: finalDriver, email });
  }

  if (path === "/sessions") {
    if (req.method === "POST") {
      const body = await req.json();
      const rows = (Array.isArray(body) ? body : [body]).map((e) => sessionRow(driver_id, e));
      const { error } = await db.from("sessions").insert(rows);
      return error ? json({ error: error.message }, 400) : json({ inserted: rows.length }, 201);
    }
    if (req.method === "GET") {
      const { data } = await db.from("sessions").select("*").eq("driver_id", driver_id).order("occurred_on", { ascending: false });
      return json(data ?? []);
    }
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id required" }, 400);
      await db.from("sessions").delete().eq("driver_id", driver_id).eq("id", id);
      return new Response(null, { status: 204, headers: CORS });
    }
  }

  if (path === "/expenses") {
    if (req.method === "POST") {
      const e = await req.json();
      const { error } = await db.from("expenses").insert({
        driver_id, spent_on: e.date ?? e.spent_on, category: e.category, amount_cents: dollarsToCents(e.amount),
      });
      return error ? json({ error: error.message }, 400) : json({ ok: true }, 201);
    }
    if (req.method === "GET") {
      const { data } = await db.from("expenses").select("*").eq("driver_id", driver_id).order("spent_on", { ascending: false });
      return json(data ?? []);
    }
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      await db.from("expenses").delete().eq("driver_id", driver_id).eq("id", id);
      return new Response(null, { status: 204, headers: CORS });
    }
  }

  if (path === "/push/subscribe") {
    if (req.method === "POST") {
      const b = await req.json();
      const { error } = await db.from("push_subscriptions").insert({
        driver_id, sub: b.subscription, market: b.market,
        platforms: b.platforms ?? [], home_geohash5: b.home_geohash5 ?? null,
      });
      return error ? json({ error: error.message }, 400) : json({ ok: true }, 201);
    }
    if (req.method === "DELETE") {
      await db.from("push_subscriptions").delete().eq("driver_id", driver_id);
      return new Response(null, { status: 204, headers: CORS });
    }
  }

  return json({ error: "not found", path }, 404);
});
