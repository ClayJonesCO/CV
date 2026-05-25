// Peakr backend client — dependency-free, feature-flagged.
//
// DISABLED by default: with no API base configured, every method is a safe
// no-op and the app runs exactly as the standalone static demo (seeded
// community data + localStorage). It turns on when an API base URL is set via:
//   window.PEAKR_CONFIG = { apiBase: "https://<ref>.functions.supabase.co/api" }
// (e.g. from an un-committed config.js) or localStorage "peakr.apiBase".
(function () {
  const TOKEN_KEY = "peakr.token";

  function apiBase() {
    return (window.PEAKR_CONFIG && window.PEAKR_CONFIG.apiBase) ||
      (function () { try { return localStorage.getItem("peakr.apiBase"); } catch (e) { return null; } })() ||
      "";
  }
  function enabled() { return !!apiBase(); }

  function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ } }

  async function ensureToken() {
    if (!enabled()) return null;
    let t = getToken();
    if (t) return t;
    try {
      const r = await fetch(`${apiBase()}/auth/anon`, { method: "POST" });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.token) { setToken(j.token); return j.token; }
    } catch (e) { /* offline; stay anonymous-local */ }
    return null;
  }

  // Returns { drivers, byPlatform, cells } or null. Never throws.
  async function fetchMarketModel(market) {
    if (!enabled()) return null;
    try {
      const r = await fetch(`${apiBase()}/market-model?market=${encodeURIComponent(market)}`);
      if (!r.ok) return null;
      const m = await r.json();
      return m && m.byPlatform ? m : null;
    } catch (e) { return null; }
  }

  // Best-effort mirror of a logged session to the flywheel. Never throws.
  async function postSession(entry) {
    if (!enabled()) return;
    const token = await ensureToken();
    if (!token) return;
    try {
      await fetch(`${apiBase()}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
        body: JSON.stringify(entry),
      });
    } catch (e) { /* offline; the local log is the source of truth */ }
  }

  async function postExpense(expense) {
    if (!enabled()) return;
    const token = await ensureToken();
    if (!token) return;
    try {
      await fetch(`${apiBase()}/expenses`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
        body: JSON.stringify(expense),
      });
    } catch (e) { /* ignore */ }
  }

  window.PEAKR_API = { enabled, ensureToken, fetchMarketModel, postSession, postExpense };
})();
