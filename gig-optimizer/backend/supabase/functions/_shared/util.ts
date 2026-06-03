// Shared helpers for Peakr Edge Functions.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};

export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Verify a Stripe webhook signature: header is "t=<unix>,v1=<hex(hmac_sha256(secret, t.payload))>".
// Includes a 5-min replay window and constant-time comparison.
export async function verifyStripeSig(sig: string | null, payload: string, secret: string | undefined): Promise<boolean> {
  if (!sig || !secret) return false;
  const parts: Record<string, string> = {};
  for (const p of sig.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1);
  }
  const t = parts["t"], v1 = parts["v1"];
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(t, 10)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// Resolve the driver from the opaque bearer token; touch last_seen.
export async function driverFromToken(db: SupabaseClient, req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data } = await db.from("device_tokens").select("driver_id").eq("token", token).maybeSingle();
  if (!data) return null;
  db.from("device_tokens").update({ last_seen: new Date().toISOString() }).eq("token", token).then(() => {});
  return data.driver_id;
}
