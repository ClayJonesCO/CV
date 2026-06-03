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

  // Record a bonus-link click; returns { url } with a tracking subid, or null.
  async function trackReferralClick(platform, market) {
    if (!enabled()) return null;
    const token = await ensureToken();
    if (!token) return null;
    try {
      const r = await fetch(`${apiBase()}/referrals/click`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
        body: JSON.stringify({ platform, market }),
      });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  // --- Phase 2: live forecast + events proxy ---
  // Returns { source, days:[{date,weatherKey,tempMax,tempMin,precip,event}] } or null.
  async function fetchForecast(market) {
    if (!enabled()) return null;
    try {
      const r = await fetch(`${apiBase()}/forecast?market=${encodeURIComponent(market)}`);
      if (!r.ok) return null;
      const j = await r.json();
      return j && Array.isArray(j.days) ? j : null;
    } catch (e) { return null; }
  }

  // --- Phase 3: email accounts + cross-device sync ---
  async function authed(pathName, opts = {}) {
    const token = await ensureToken();
    if (!token) return null;
    try {
      const r = await fetch(`${apiBase()}${pathName}`, {
        ...opts,
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}`, ...(opts.headers || {}) },
      });
      return r.ok ? await r.json().catch(() => ({})) : null;
    } catch (e) { return null; }
  }

  function me() { return authed("/me"); }
  function requestEmailCode(email) {
    return authed("/auth/email", { method: "POST", body: JSON.stringify({ email }) });
  }
  function verifyEmailCode(email, code) {
    return authed("/auth/verify", { method: "POST", body: JSON.stringify({ email, code }) });
  }

  // Pull the account's server-side history (maps snake_case/cents → client shape).
  async function pullSessions() {
    const rows = await authed("/sessions");
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
      id: r.id, date: r.occurred_on, platform: r.platform, startHour: r.start_hour,
      hours: Number(r.hours), actualGross: r.gross_cents / 100,
      predictedGross: r.predicted_cents != null ? r.predicted_cents / 100 : 0,
    }));
  }
  async function pullExpenses() {
    const rows = await authed("/expenses");
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({ id: r.id, date: r.spent_on, category: r.category, amount: r.amount_cents / 100 }));
  }

  // --- Billing (Stripe Checkout + Customer Portal) ---
  // Returns { url } to redirect to, or null on failure / not configured.
  async function startCheckout() {
    return authed("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ return_url: location.href.split("?")[0] }),
    });
  }
  async function openBillingPortal() {
    return authed("/billing/portal", {
      method: "POST",
      body: JSON.stringify({ return_url: location.href.split("?")[0] }),
    });
  }

  window.PEAKR_API = {
    enabled, ensureToken, fetchMarketModel, postSession, postExpense, trackReferralClick,
    fetchForecast, me, requestEmailCode, verifyEmailCode, pullSessions, pullExpenses,
    startCheckout, openBillingPortal,
  };
})();
