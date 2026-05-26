// Peakr operator analytics dashboard. Uses the live /admin/analytics endpoint
// when an API base + admin key are configured; otherwise renders demo data so
// the view is meaningful in the standalone build.

const PLATFORM_NAMES = {
  uber: "Uber", lyft: "Lyft", doordash: "DoorDash", ubereats: "Uber Eats",
  grubhub: "Grubhub", instacart: "Instacart", spark: "Walmart Spark", amazonflex: "Amazon Flex",
};
const MARKET_NAMES = {
  nash: "Nashville, TN", nyc: "New York City, NY", la: "Los Angeles, CA",
  chi: "Chicago, IL", atx: "Austin, TX", atl: "Atlanta, GA", den: "Denver, CO",
};

function apiBase() {
  return (window.PEAKR_CONFIG && window.PEAKR_CONFIG.apiBase) ||
    (function () { try { return localStorage.getItem("peakr.apiBase"); } catch (e) { return null; } })() || "";
}
function adminKey() {
  return document.getElementById("admin-key").value ||
    (function () { try { return localStorage.getItem("peakr.adminKey"); } catch (e) { return ""; } })() || "";
}
function money(cents) { return "$" + (cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function pct(n, d) { return d > 0 ? (100 * n / d).toFixed(1) + "%" : "—"; }
function num(n) { return (n || 0).toLocaleString(); }

function demoData() {
  const byP = [
    { platform: "spark", clicks: 214, conversions: 51, revenue_cents: 51 * 25000 },
    { platform: "instacart", clicks: 188, conversions: 39, revenue_cents: 39 * 20000 },
    { platform: "doordash", clicks: 162, conversions: 28, revenue_cents: 28 * 17500 },
    { platform: "uber", clicks: 143, conversions: 22, revenue_cents: 22 * 15000 },
    { platform: "amazonflex", clicks: 121, conversions: 19, revenue_cents: 19 * 10000 },
    { platform: "lyft", clicks: 96, conversions: 12, revenue_cents: 12 * 13000 },
  ];
  return {
    drivers: 1840, accounts: 612, sessions: 38420, sessions_7d: 5127,
    clicks: byP.reduce((s, p) => s + p.clicks, 0),
    conversions: byP.reduce((s, p) => s + p.conversions, 0),
    revenue_cents: byP.reduce((s, p) => s + p.revenue_cents, 0),
    by_platform: byP,
    top_markets: [
      { market: "nash", sessions: 22700, drivers: 1180 },
      { market: "nyc", sessions: 6120, drivers: 320 },
      { market: "la", sessions: 4880, drivers: 280 },
      { market: "atl", sessions: 1940, drivers: 110 },
      { market: "chi", sessions: 1780, drivers: 120 },
    ],
  };
}

async function fetchLive() {
  const r = await fetch(`${apiBase()}/admin/analytics`, { headers: { "x-admin-key": adminKey() } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

function kpi(label, value, sub) {
  return `<div class="kpi"><div class="label">${label}</div><div class="val">${value}</div>${sub ? `<div class="sublabel">${sub}</div>` : ""}</div>`;
}

function render(d, live) {
  const banner = document.getElementById("admin-banner");
  if (live) {
    banner.className = "plan-status ok";
    banner.textContent = `Live metrics from your Peakr backend · generated ${new Date(d.generated_at || Date.now()).toLocaleString()}`;
  } else {
    banner.className = "plan-status warn";
    banner.textContent = "Demo data — set the API base (config.js / localStorage) and enter your admin key to load live metrics.";
  }

  document.getElementById("admin-kpis").innerHTML = [
    kpi("Drivers", num(d.drivers), "total signed up"),
    kpi("Accounts", num(d.accounts), "email, multi-device"),
    kpi("Sessions logged", num(d.sessions), "the flywheel"),
    kpi("Sessions (7d)", num(d.sessions_7d), "last week"),
    kpi("Referral clicks", num(d.clicks), "bonus links"),
    kpi("Conversions", num(d.conversions), pct(d.conversions, d.clicks) + " of clicks"),
    kpi("Bonus revenue", money(d.revenue_cents), "from sign-ups"),
    kpi("Rev / driver", d.drivers ? money(d.revenue_cents / d.drivers) : "—", "lifetime, so far"),
  ].join("");

  document.getElementById("admin-platforms").innerHTML = (d.by_platform || []).map(p => `
    <tr>
      <td>${PLATFORM_NAMES[p.platform] || p.platform}</td>
      <td class="num">${num(p.clicks)}</td>
      <td class="num">${num(p.conversions)}</td>
      <td class="num">${pct(p.conversions, p.clicks)}</td>
      <td class="num">${money(p.revenue_cents)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">No referral activity yet.</td></tr>`;

  document.getElementById("admin-markets").innerHTML = (d.top_markets || []).map(m => `
    <tr>
      <td>${MARKET_NAMES[m.market] || m.market}</td>
      <td class="num">${num(m.sessions)}</td>
      <td class="num">${num(m.drivers)}</td>
    </tr>`).join("") || `<tr><td colspan="3" class="muted">No sessions logged yet.</td></tr>`;
}

async function load() {
  if (apiBase() && adminKey()) {
    try {
      localStorage.setItem("peakr.adminKey", adminKey());
      render(await fetchLive(), true);
      return;
    } catch (e) {
      document.getElementById("admin-banner").className = "plan-status warn";
      document.getElementById("admin-banner").textContent = "Couldn't load live metrics (" + e.message + "). Showing demo data.";
    }
  }
  render(demoData(), false);
}

document.addEventListener("DOMContentLoaded", () => {
  try { const k = localStorage.getItem("peakr.adminKey"); if (k) document.getElementById("admin-key").value = k; } catch (e) {}
  document.getElementById("admin-refresh").addEventListener("click", load);
  load();
});
