// External data feeds for the Phase-2 proxy: weather (Open-Meteo, no key) and
// events (Ticketmaster Discovery, needs TICKETMASTER_API_KEY). Both are cached
// in Postgres so we hit the upstreams rarely and keep keys server-side.
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const FORECAST_TTL_MIN = 90;
const EVENTS_TTL_MIN = 720;   // 12h

export function wmoToKey(code: number, tmaxF: number): string {
  if (typeof tmaxF === "number" && tmaxF >= 95) return "hot";
  if ([95, 96, 99].includes(code)) return "storm";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([2, 3, 45, 48].includes(code)) return "cloudy";
  if ([0, 1].includes(code)) return "clear";
  return "cloudy";
}

function classifyEvent(segment: string, genre: string): string {
  const s = `${segment} ${genre}`.toLowerCase();
  if (s.includes("sport")) return "sports";
  if (s.includes("conv") || s.includes("expo") || s.includes("trade")) return "convention";
  return "concert";
}

async function marketCoords(db: SupabaseClient, market: string) {
  const { data } = await db.from("markets").select("lat,lng").eq("ref", market).maybeSingle();
  return data;
}

function freshEnough(fetchedAt: string | null, ttlMin: number): boolean {
  if (!fetchedAt) return false;
  return (Date.now() - new Date(fetchedAt).getTime()) < ttlMin * 60_000;
}

// 7-day weather, cached in forecast_cache.
export async function getForecast(db: SupabaseClient, market: string) {
  const { data: cached } = await db.from("forecast_cache").select("*").eq("market", market).order("on_date");
  if (cached?.length && freshEnough(cached[0].fetched_at, FORECAST_TTL_MIN)) {
    return cached.map((d) => mapForecastRow(d));
  }
  const c = await marketCoords(db, market);
  if (!c) return [];
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&timezone=auto&forecast_days=7`;
  const r = await fetch(url);
  if (!r.ok) return cached?.map((d) => mapForecastRow(d)) ?? [];
  const j = await r.json();
  const d = j.daily;
  const rows = d.time.map((date: string, i: number) => ({
    market, on_date: date, weather_code: d.weather_code[i],
    tmax_f: Math.round(d.temperature_2m_max[i]), tmin_f: Math.round(d.temperature_2m_min[i]),
    precip: d.precipitation_probability_max?.[i] ?? null, fetched_at: new Date().toISOString(),
  }));
  await db.from("forecast_cache").upsert(rows, { onConflict: "market,on_date" });
  return rows.map((d) => mapForecastRow(d));
}

function mapForecastRow(d: Record<string, any>) {
  return {
    date: d.on_date,
    weatherKey: wmoToKey(d.weather_code, d.tmax_f),
    tempMax: d.tmax_f, tempMin: d.tmin_f, precip: d.precip, live: true,
  };
}

// Upcoming events keyed by date, cached in events_cache.
export async function getEvents(db: SupabaseClient, market: string) {
  const { data: cached } = await db.from("events_cache").select("*").eq("market", market);
  if (cached?.length && freshEnough(cached[0].fetched_at, EVENTS_TTL_MIN)) {
    return eventsByDate(cached);
  }
  const key = Deno.env.get("TICKETMASTER_API_KEY");
  const c = await marketCoords(db, market);
  if (!key || !c) return eventsByDate(cached ?? []);
  const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${key}` +
    `&latlong=${c.lat},${c.lng}&radius=25&unit=miles&size=40&sort=date,asc&startDateTime=${new Date().toISOString().slice(0, 19)}Z`;
  const r = await fetch(url);
  if (!r.ok) return eventsByDate(cached ?? []);
  const j = await r.json();
  const evs = (j._embedded?.events ?? []).map((e: any) => {
    const seg = e.classifications?.[0]?.segment?.name ?? "";
    const genre = e.classifications?.[0]?.genre?.name ?? "";
    return {
      market, on_date: (e.dates?.start?.localDate ?? "").slice(0, 10),
      venue: e._embedded?.venues?.[0]?.name ?? e.name,
      kind: classifyEvent(seg, genre), source: "ticketmaster",
      fetched_at: new Date().toISOString(),
    };
  }).filter((e: any) => e.on_date);
  if (evs.length) {
    await db.from("events_cache").delete().eq("market", market);
    await db.from("events_cache").upsert(evs, { onConflict: "market,on_date,venue" });
  }
  return eventsByDate(evs.length ? evs : (cached ?? []));
}

// First event per date → { 'YYYY-MM-DD': { name, type } } to match the client.
function eventsByDate(rows: Record<string, any>[]) {
  const out: Record<string, { name: string; type: string }> = {};
  for (const e of rows) if (!out[e.on_date]) out[e.on_date] = { name: e.venue, type: e.kind };
  return out;
}
