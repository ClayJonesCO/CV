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
