// Gig Economy Optimizer — recommendation engine and UI controller.

const { PLATFORMS, MARKETS, WEATHER_MODIFIERS, EVENT_BOOSTS, DAYS, curveForDay } = window.GIG_DATA;
const { vehicleMakes, vehicleModels, vehicleYears, lookupMPG } = window.VEHICLES;
const { communityFor, communityDrivers, communityTotalSamples, setMarketModel, REFERRALS } = window.COMMUNITY;
const API = window.PEAKR_API;

const TYPE_TO_CATEGORY = {
  "rideshare": "rideshare",
  "food-delivery": "delivery",
  "grocery": "grocery",
  "package": "delivery",
};

// Tax model constants (U.S. 1099 independent contractor).
const IRS_MILEAGE_RATE = 0.70;   // 2025 standard business mileage deduction ($/mi)
const SE_TAX_RATE = 0.153;       // Social Security + Medicare
const SE_TAXABLE_PORTION = 0.9235;
const VEHICLE_WEAR_RATE = 0.09;  // non-fuel operating cost proxy ($/mi)

// Monetization
const TRIAL_DAYS = 14;
const PRO_PRICE = 9;

const state = {
  market: "nash",
  weather: "clear",
  event: "none",
  planMode: "hours",        // "hours" | "goal"
  hoursPerWeek: 30,
  incomeGoal: 1000,         // weekly take-home target in goal mode
  vehicleMake: "",
  vehicleModel: "",
  vehicleYear: null,
  mpg: 26,
  mpgAuto: false,
  fuelPrice: MARKETS.nash.fuelCost,
  fuelPriceCustom: false,
  incomeTaxRate: 0.12,
  acceptanceRate: 0.85,
  selectedPlatforms: new Set(["uber", "lyft", "doordash", "ubereats"]),
  earningsLog: [],          // [{ id, date, platform, startHour, hours, actualGross, predictedGross }]
  expenses: [],             // [{ id, date, category, amount }]
  calibrationFactor: 1.0,   // derived: total actual / total predicted across the log
  forecast: [],             // 7-day outlook: [{ date, weatherKey, tempMax, tempMin, precip, event, live }]
  tier: "free",             // "free" | "trial" | "pro"
  proSource: null,          // null | "paid" | "referral"
  trialStartedAt: null,     // ISO date string
  trialRecapDismissed: false,
};

const EXPENSE_CATEGORIES = ["Gas", "Maintenance", "Phone & data", "Supplies", "Tolls & parking", "Insurance", "Other"];

// Which platform types can be run simultaneously ("stacked") to cut idle time.
// Package work (Amazon Flex) is block-based and doesn't stack.
const STACK_COMPAT = {
  "rideshare": ["rideshare", "food-delivery"],
  "food-delivery": ["food-delivery", "grocery"],
  "grocery": ["grocery", "food-delivery"],
  "package": [],
};

function milesPerHourFor(platformId) {
  return PLATFORMS[platformId].type === "rideshare" ? 22 : 18;
}

function estimateHourlyEarnings(platformId, dayIndex, hour, opts = {}) {
  const calibrated = opts.calibrated !== false;
  const weatherKey = opts.weather || state.weather;
  const eventKey = opts.event || state.event;
  const p = PLATFORMS[platformId];
  const market = MARKETS[state.market];
  const curve = curveForDay(platformId, dayIndex);
  const demand = curve[hour];
  const category = TYPE_TO_CATEGORY[p.type];
  const weatherMod = WEATHER_MODIFIERS[weatherKey][category] || 1.0;
  const eventMod = EVENT_BOOSTS[eventKey][category] || 1.0;

  const surge = Math.min(p.surgeCeiling, Math.max(1.0, demand));
  const base = p.baselineHourly * market.multiplier;
  let gross = base * surge * weatherMod * eventMod;
  if (calibrated) gross *= effectiveFactor(platformId);

  // Fuel & vehicle cost estimate per hour of active work
  const milesPerHour = milesPerHourFor(platformId);
  const mpg = state.mpg > 0 ? state.mpg : 26;
  const fuelCost = (milesPerHour / mpg) * state.fuelPrice;
  const wearCost = milesPerHour * VEHICLE_WEAR_RATE;

  const net = gross - fuelCost - wearCost;
  return {
    gross: Math.max(0, gross),
    net: Math.max(0, net),
    miles: milesPerHour,
    fuelCost,
    wearCost,
    surge,
    demand,
  };
}

// Blend the community crowd-calibration (per market+platform) with the
// driver's own logged calibration. Community sets the starting crowd factor;
// the driver's personal logs progressively override it as they accumulate.
function effectiveFactor(platformId) {
  const comm = communityFor(state.market, platformId);
  const base = comm.samples > 0 ? comm.mult : 1.0;
  const personalSamples = state.earningsLog.length;
  let factor = base;
  if (personalSamples > 0) {
    const w = Math.min(personalSamples, 12) / 12;   // saturates at 12 sessions
    factor = base * (1 - w) + state.calibrationFactor * w;
  }
  return Math.min(3, Math.max(0.3, factor));
}

// Compute take-home after estimated self-employment + income tax.
// Mileage deduction (IRS standard rate) reduces taxable income.
function computeTaxes(gross, miles) {
  const mileageDeduction = miles * IRS_MILEAGE_RATE;
  const taxable = Math.max(0, gross - mileageDeduction);
  const seTax = taxable * SE_TAXABLE_PORTION * SE_TAX_RATE;
  const incomeTax = taxable * state.incomeTaxRate;
  return { mileageDeduction, taxable, seTax, incomeTax, totalTax: seTax + incomeTax };
}

function bestPlatformAt(dayIndex, hour) {
  let best = null;
  for (const id of state.selectedPlatforms) {
    const est = estimateHourlyEarnings(id, dayIndex, hour);
    if (!best || est.net > best.est.net) best = { id, est };
  }
  return best;
}

function buildWeeklyHeatmap() {
  const grid = [];
  for (let d = 0; d < 7; d++) {
    const row = [];
    for (let h = 0; h < 24; h++) {
      row.push(bestPlatformAt(d, h));
    }
    grid.push(row);
  }
  return grid;
}

function buildSlots(grid) {
  const slots = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const b = grid[d][h];
      if (b) slots.push({ d, h, ...b });
    }
  }
  slots.sort((a, b) => b.est.net - a.est.net);
  return slots;
}

function selectByHours(slots, hoursTarget) {
  return slots.slice(0, hoursTarget);
}

// Greedily add the most profitable hours until projected weekly take-home
// (after fuel, wear, and taxes) reaches the goal. Returns chosen slots and
// whether the goal was reachable within the week.
function selectByGoal(slots, goal) {
  let gross = 0, miles = 0, netCash = 0;
  const chosen = [];
  for (const s of slots) {
    chosen.push(s);
    gross += s.est.gross;
    miles += s.est.miles;
    netCash += s.est.net;
    const tax = computeTaxes(gross, miles);
    if (netCash - tax.totalTax >= goal) return { chosen, reached: true };
  }
  return { chosen, reached: false };
}

function byTime(a, b) {
  return (a.d * 24 + a.h) - (b.d * 24 + b.h);
}

function stackSuggestions(primaryId, d, startHour, endHour) {
  const compat = STACK_COMPAT[PLATFORMS[primaryId].type] || [];
  const cands = [];
  for (const id of state.selectedPlatforms) {
    if (id === primaryId) continue;
    if (!compat.includes(PLATFORMS[id].type)) continue;
    let bestNet = 0, demandSum = 0, n = 0;
    for (let h = startHour; h < endHour; h++) {
      const est = estimateHourlyEarnings(id, d, h % 24);
      bestNet = Math.max(bestNet, est.net);
      demandSum += est.demand; n++;
    }
    const avgDemand = n ? demandSum / n : 0;
    if (avgDemand >= 0.7) cands.push({ id, net: bestNet, demand: avgDemand });
  }
  cands.sort((a, b) => b.net - a.net);
  return cands.slice(0, 2);
}

function groupShifts(chosen) {
  const shifts = [];
  let cur = null;
  for (const s of chosen) {
    if (cur && cur.d === s.d && cur.endHour === s.h && cur.id === s.id) {
      cur.endHour = s.h + 1;
      cur.totalNet += s.est.net;
      cur.totalGross += s.est.gross;
      cur.totalMiles += s.est.miles;
      cur.hours += 1;
    } else {
      if (cur) shifts.push(cur);
      cur = {
        d: s.d, startHour: s.h, endHour: s.h + 1,
        id: s.id, hours: 1,
        totalNet: s.est.net, totalGross: s.est.gross,
        totalMiles: s.est.miles,
      };
    }
  }
  if (cur) shifts.push(cur);
  return shifts;
}

function recommendZones(dayIndex, hour) {
  const market = MARKETS[state.market];
  const zones = market.zones.map(z => {
    let score = 0;
    for (const id of state.selectedPlatforms) {
      const p = PLATFORMS[id];
      const cat = TYPE_TO_CATEGORY[p.type];
      const zoneDemand = z.demand[cat] || 1.0;
      const est = estimateHourlyEarnings(id, dayIndex, hour);
      score = Math.max(score, est.net * zoneDemand);
    }
    return { ...z, score };
  });
  zones.sort((a, b) => b.score - a.score);
  return zones;
}

function fmt(n) {
  return "$" + n.toFixed(2);
}

// Small "?" tooltip for explaining jargon in plain language.
function tip(text) {
  const safe = text.replace(/"/g, "&quot;");
  return `<span class="info" tabindex="0" role="note" aria-label="${safe}">?<span class="tip">${text}</span></span>`;
}
function hourLabel(h) {
  const period = h < 12 ? "AM" : "PM";
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hh}${period}`;
}
function rangeLabel(s, e) {
  return `${hourLabel(s)}–${hourLabel(e % 24)}`;
}

// ---------------- Rendering ----------------

function renderMarketOptions() {
  const sel = document.getElementById("market");
  sel.innerHTML = "";
  for (const [id, m] of Object.entries(MARKETS)) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = m.name;
    sel.appendChild(opt);
  }
  sel.value = state.market;
}

function renderPlatformChoices() {
  const wrap = document.getElementById("platforms");
  wrap.innerHTML = "";
  for (const [id, p] of Object.entries(PLATFORMS)) {
    const label = document.createElement("label");
    label.className = "pchip";
    label.style.borderColor = p.color;
    label.innerHTML = `
      <input type="checkbox" value="${id}" ${state.selectedPlatforms.has(id) ? "checked" : ""}>
      <span style="background:${p.color}"></span>
      ${p.name}
    `;
    label.querySelector("input").addEventListener("change", e => {
      if (e.target.checked) state.selectedPlatforms.add(id);
      else state.selectedPlatforms.delete(id);
      renderAll();
    });
    wrap.appendChild(label);
  }
}

function renderHeatmap(grid) {
  const tbl = document.getElementById("heatmap");
  tbl.innerHTML = "";
  const header = document.createElement("tr");
  header.appendChild(document.createElement("th"));
  for (let h = 0; h < 24; h++) {
    const th = document.createElement("th");
    th.textContent = hourLabel(h);
    header.appendChild(th);
  }
  tbl.appendChild(header);

  let maxNet = 0;
  grid.forEach(row => row.forEach(c => { if (c && c.est.net > maxNet) maxNet = c.est.net; }));

  for (let d = 0; d < 7; d++) {
    const tr = document.createElement("tr");
    const lbl = document.createElement("th");
    lbl.textContent = DAYS[d].slice(0, 3);
    tr.appendChild(lbl);
    for (let h = 0; h < 24; h++) {
      const c = grid[d][h];
      const td = document.createElement("td");
      if (c) {
        const intensity = maxNet > 0 ? c.est.net / maxNet : 0;
        const p = PLATFORMS[c.id];
        td.style.background = p.color;
        td.style.opacity = (0.25 + 0.75 * intensity).toFixed(2);
        td.title = `${DAYS[d]} ${hourLabel(h)} — ${p.name}: ${fmt(c.est.net)}/hr (gross ${fmt(c.est.gross)}, ${c.est.surge.toFixed(2)}× demand)`;
      }
      tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }
}

function renderSchedule(shifts) {
  const list = document.getElementById("schedule");
  list.innerHTML = "";
  let weeklyNet = 0, weeklyGross = 0, weeklyHours = 0, weeklyMiles = 0;

  const byDay = {};
  for (const s of shifts) {
    (byDay[s.d] = byDay[s.d] || []).push(s);
    weeklyNet += s.totalNet;
    weeklyGross += s.totalGross;
    weeklyHours += s.hours;
    weeklyMiles += s.totalMiles;
  }

  for (let d = 0; d < 7; d++) {
    if (!byDay[d]) continue;
    const dayEl = document.createElement("div");
    dayEl.className = "day";
    const dayHours = byDay[d].reduce((s, x) => s + x.hours, 0);
    const dayNet = byDay[d].reduce((s, x) => s + x.totalNet, 0);
    dayEl.innerHTML = `<h4>${DAYS[d]} <span class="muted">${dayHours}h · ${fmt(dayNet)}</span></h4>`;
    for (const s of byDay[d]) {
      const p = PLATFORMS[s.id];
      const stack = stackSuggestions(s.id, s.d, s.startHour, s.endHour);
      const stackHtml = stack.length
        ? `<span class="stack" title="Run these apps at the same time to cut idle time">+ ${stack.map(c =>
            `<span class="stack-chip"><span class="sdot" style="background:${PLATFORMS[c.id].color}"></span>${PLATFORMS[c.id].name}</span>`
          ).join("")}</span>`
        : "";
      const shift = document.createElement("div");
      shift.className = "shift";
      shift.innerHTML = `
        <span class="dot" style="background:${p.color}"></span>
        <span class="time">${rangeLabel(s.startHour, s.endHour)}</span>
        <span class="plat">${p.name}${stackHtml}</span>
        <span class="earn">${fmt(s.totalNet)} <span class="muted">(${fmt(s.totalNet / s.hours)}/hr)</span></span>
      `;
      dayEl.appendChild(shift);
    }
    list.appendChild(dayEl);
  }

  document.getElementById("summary-hours").textContent = `${weeklyHours}h`;
  document.getElementById("summary-net").textContent = fmt(weeklyNet);
  document.getElementById("summary-gross").textContent = fmt(weeklyGross);
  const avg = weeklyHours > 0 ? weeklyNet / weeklyHours : 0;
  document.getElementById("summary-avg").textContent = fmt(avg) + "/hr";
  document.getElementById("summary-annual").textContent = fmt(weeklyNet * 50);

  renderBreakdown(weeklyGross, weeklyNet, weeklyMiles, weeklyHours);
}

function renderBreakdown(gross, netCash, miles, hours) {
  const fuel = state.mpg > 0
    ? (miles / state.mpg) * state.fuelPrice : 0;
  const wear = miles * VEHICLE_WEAR_RATE;
  const tax = computeTaxes(gross, miles);
  const takeHome = netCash - tax.totalTax;
  const effHourly = hours > 0 ? takeHome / hours : 0;

  const rows = [
    ["Gross earnings" + tip("Everything the apps paid you this week, before costs."), gross, "pos"],
    ["Fuel", -fuel, "neg"],
    ["Vehicle wear &amp; maintenance" + tip("Tires, oil, brakes, depreciation — about $0.09 per mile driven."), -wear, "neg"],
    ["Self-employment tax (15.3%)" + tip("Social Security + Medicare. Employees split this with an employer; as a contractor you pay both halves."), -tax.seTax, "neg"],
    [`Income tax (${Math.round(state.incomeTaxRate * 100)}%)` + tip("Estimated federal income tax at the bracket you picked in the sidebar."), -tax.incomeTax, "neg"],
  ];

  const tbody = document.getElementById("breakdown-rows");
  tbody.innerHTML = "";
  for (const [label, val, cls] of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${label}</td><td class="num ${cls}">${val < 0 ? "−" : ""}${fmt(Math.abs(val))}</td>`;
    tbody.appendChild(tr);
  }

  document.getElementById("breakdown-takehome").textContent = fmt(takeHome);
  document.getElementById("breakdown-takehome-annual").textContent = fmt(takeHome * 50) + " / yr";
  document.getElementById("breakdown-effhourly").textContent = fmt(effHourly) + "/hr take-home";
  document.getElementById("breakdown-miles").textContent = `${Math.round(miles)} mi/wk`;
  document.getElementById("breakdown-deduction").textContent =
    `${fmt(tax.mileageDeduction)} mileage deduction (${miles ? Math.round(miles) : 0} mi × $${IRS_MILEAGE_RATE.toFixed(2)})`;
}

function renderZones() {
  const now = new Date();
  const d = now.getDay();
  const h = now.getHours();
  const zones = recommendZones(d, h);
  const ul = document.getElementById("zones");
  ul.innerHTML = "";
  zones.slice(0, 5).forEach((z, idx) => {
    const li = document.createElement("li");
    li.className = "zone";
    li.innerHTML = `
      <span class="rank">${idx + 1}</span>
      <div class="zinfo">
        <div class="zname">${z.name}</div>
        <div class="zscore muted">Opportunity score ${z.score.toFixed(1)}</div>
      </div>
      <span class="zbar" style="width:${Math.min(100, z.score * 2)}%"></span>
    `;
    ul.appendChild(li);
  });
  document.getElementById("zones-context").textContent =
    `${DAYS[d]} ${hourLabel(h)} · ${WEATHER_MODIFIERS[state.weather].label} · ${MARKETS[state.market].name}`;
}

function renderNowRecommendation() {
  const now = new Date();
  const d = now.getDay();
  const h = now.getHours();
  const best = bestPlatformAt(d, h);
  const card = document.getElementById("now-card");
  if (!best) {
    card.innerHTML = `<p class="muted">Pick at least one app in the sidebar (under "Apps you can drive for") to get a recommendation.</p>`;
    return;
  }
  const p = PLATFORMS[best.id];
  const zones = recommendZones(d, h);
  const zone = zones.length ? zones[0] : null;
  const dem = best.est.demand;
  let rating, ratingCls;
  if (dem >= 1.6) { rating = "Busy right now — great time to drive"; ratingCls = "busy"; }
  else if (dem >= 1.0) { rating = "Steady demand right now"; ratingCls = "steady"; }
  else { rating = "Slow right now — you may wait between jobs"; ratingCls = "slow"; }

  const conf = confidenceFor(state.market);
  card.innerHTML = `
    <div class="hero" style="--c:${p.color}">
      <div class="hero-badge" style="background:${p.color}">${p.name[0]}</div>
      <div class="hero-main">
        <div class="hero-line">It's ${DAYS[d]} ${hourLabel(h)}. Your best move is to drive
          <strong style="color:${p.color}">${p.name}</strong>${zone ? ` around <strong>${zone.name}</strong>` : ""}.</div>
        <div class="hero-rating ${ratingCls}">${rating}</div>
        <div class="hero-conf"><span class="conf-dot ${conf.cls}"></span>${conf.label} · based on ${conf.count.toLocaleString()} driver-sessions in ${MARKETS[state.market].name.split(",")[0]}</div>
      </div>
      <div class="hero-earn">
        <div class="hero-num">${fmt(best.est.net)}<span class="muted">/hr</span></div>
        <div class="muted">take-home after gas &amp; car costs (before taxes)</div>
      </div>
    </div>
  `;
}

// Data confidence for a market = pooled community sessions + this driver's logs.
function confidenceFor(market) {
  const count = communityTotalSamples(market) + state.earningsLog.length;
  let label, cls;
  if (count >= 1000) { label = "High-confidence local data"; cls = "busy"; }
  else if (count >= 200) { label = "Moderate local data"; cls = "steady"; }
  else if (count >= 20) { label = "Limited local data"; cls = "slow"; }
  else { label = "Modeled estimate — little local data yet"; cls = "slow"; }
  return { count, label, cls };
}

function renderComparison() {
  const now = new Date();
  const d = now.getDay();
  const h = now.getHours();
  const rows = [...state.selectedPlatforms]
    .map(id => ({ id, est: estimateHourlyEarnings(id, d, h) }))
    .sort((a, b) => b.est.net - a.est.net);

  const tbody = document.getElementById("compare-rows");
  if (!tbody) return;
  tbody.innerHTML = "";
  const max = rows.length ? rows[0].est.net : 0;

  for (const r of rows) {
    const p = PLATFORMS[r.id];
    const pct = max > 0 ? (r.est.net / max) * 100 : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cp-name"><span class="dot" style="background:${p.color}"></span>${p.name}</td>
      <td class="cp-bar"><span style="width:${pct.toFixed(0)}%;background:${p.color}"></span></td>
      <td class="num">${fmt(r.est.net)}</td>
      <td class="num muted">${fmt(r.est.gross)}</td>
      <td class="num muted">${r.est.surge.toFixed(2)}×</td>
    `;
    tbody.appendChild(tr);
  }
  const ctx = document.getElementById("compare-context");
  if (ctx) ctx.textContent = `${DAYS[d]} ${hourLabel(h)} · ${MARKETS[state.market].name} · net $/hr after fuel & wear`;
}

function renderBonuses() {
  const wrap = document.getElementById("bonus-list");
  if (!wrap) return;
  const now = new Date();
  const d = now.getDay();
  const h = now.getHours();
  // Rank apps the driver ISN'T already using by how hot they are right now.
  const candidates = Object.keys(PLATFORMS)
    .filter(id => !state.selectedPlatforms.has(id) && REFERRALS[id])
    .map(id => ({ id, est: estimateHourlyEarnings(id, d, h), ref: REFERRALS[id] }))
    .sort((a, b) => b.est.net - a.est.net)
    .slice(0, 4);

  wrap.innerHTML = "";
  if (!candidates.length) {
    wrap.innerHTML = `<div class="muted" style="font-size:13px">You've selected every app with an active bonus. Nice.</div>`;
    return;
  }
  for (const c of candidates) {
    const p = PLATFORMS[c.id];
    const hot = c.est.demand >= 1.4 ? `<span class="bonus-hot">🔥 hot right now</span>` : "";
    const el = document.createElement("div");
    el.className = "bonus-card";
    el.innerHTML = `
      <span class="dot" style="background:${p.color}"></span>
      <div class="bonus-info">
        <div class="bonus-name">${p.name} ${hot}</div>
        <div class="muted" style="font-size:12px">${c.ref.blurb} · ~${fmt(c.est.net)}/hr here now</div>
      </div>
      <a class="bonus-amt" href="#" role="button" title="Example referral offer (placeholder link)">$${c.ref.amount}</a>
    `;
    el.querySelector("a").addEventListener("click", async e => {
      e.preventDefault();
      if (API && API.enabled()) {
        const res = await API.trackReferralClick(c.id, state.market);   // records click + attributes conversion
        if (res && res.url) window.open(res.url, "_blank", "noopener");
      }
    });
    wrap.appendChild(el);
  }
  const ctx = document.getElementById("bonus-context");
  if (ctx) ctx.textContent = `· ${MARKETS[state.market].name}`;
}

// ---------------- Monetization tier ----------------

// Days remaining in the user's free trial. Floors at 0 once expired.
function trialDaysLeft() {
  if (!state.trialStartedAt) return 0;
  const started = new Date(state.trialStartedAt).getTime();
  const elapsedDays = (Date.now() - started) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
}

// Effective tier with trial expiry baked in.
function effectiveTier() {
  if (state.tier === "pro") return "pro";
  if (state.tier === "trial" && trialDaysLeft() > 0) return "trial";
  return "free";
}

function isPro() {
  const t = effectiveTier();
  return t === "pro" || t === "trial";
}

function renderTier() {
  const t = effectiveTier();
  document.body.classList.toggle("pro", isPro());
  document.querySelectorAll(".pro-lock").forEach(el => {
    el.style.display = isPro() ? "none" : "flex";
  });
  const label = document.getElementById("tier-label");
  if (t === "pro") {
    label.textContent = state.proSource === "referral" ? "Pro · referral" : "Pro";
    label.className = "tier-badge pro";
  } else if (t === "trial") {
    const d = trialDaysLeft();
    label.textContent = `Trial · ${d} day${d === 1 ? "" : "s"} left`;
    label.className = "tier-badge trial";
  } else {
    label.textContent = "Free";
    label.className = "tier-badge free";
  }
  const plansBtn = document.getElementById("plans-btn");
  if (plansBtn) plansBtn.textContent = t === "pro" ? "Manage plan" : "Plans";
  // Legacy demo shortcut (kept hidden for backward-compatible test hooks).
  const legacy = document.getElementById("tier-toggle");
  if (legacy) legacy.textContent = isPro() ? "Switch to Free" : "Upgrade to Pro (Demo)";
}

// ---------------- Paywall + trial recap ----------------

function openPaywall(context, featureName) {
  const m = document.getElementById("paywall");
  if (!m) return;
  m.hidden = false;
  const headline = document.getElementById("paywall-headline");
  const sub = document.getElementById("paywall-sub");
  if (context === "feature" && featureName) {
    headline.textContent = `Unlock ${featureName}`;
    sub.textContent = "Three ways to get Pro — pick what works.";
  } else if (context === "referral") {
    headline.textContent = "Get Pro free";
    sub.textContent = "Sign up for an app you don't drive yet through Peakr — Pro is on us.";
  } else {
    headline.textContent = "Get the full Peakr";
    sub.textContent = "Pick the path that works for you.";
  }
  // Trial card disabled if already used.
  const trialBtn = document.getElementById("trial-start");
  if (trialBtn) {
    if (state.trialStartedAt) {
      trialBtn.disabled = true;
      trialBtn.textContent = "Trial already used";
    } else {
      trialBtn.disabled = false;
      trialBtn.textContent = "Start free trial";
    }
  }
}

function closePaywall() {
  const m = document.getElementById("paywall");
  if (m) m.hidden = true;
}

function startTrial() {
  if (state.trialStartedAt) return;       // one-shot
  state.trialStartedAt = new Date().toISOString();
  state.tier = "trial";
  state.trialRecapDismissed = false;
  closePaywall();
  renderAll();
}

function upgradePro() {
  // Real Stripe Checkout goes here. Demo: flip to Pro locally.
  state.tier = "pro";
  state.proSource = "paid";
  closePaywall();
  renderAll();
}

function claimReferralPro() {
  // In production the affiliate postback flips this server-side after
  // a sign-up converts. The bonus panel + paywall point users at that flow.
  state.tier = "pro";
  state.proSource = "referral";
  closePaywall();
  renderAll();
}

// Show the trial-end recap with the driver's real numbers + paths forward.
function showRecap() {
  const sessions = state.earningsLog.length;
  const earned = state.earningsLog.reduce((s, e) => s + e.actualGross, 0);
  const cal = state.calibrationFactor;
  // Projected weekly take-home from the currently-optimized schedule.
  const grid = buildWeeklyHeatmap();
  const slots = buildSlots(grid);
  const chosen = selectByHours(slots, state.hoursPerWeek);
  const projected = chosen.reduce((s, x) => s + x.est.net, 0);

  document.getElementById("recap-sessions").textContent = sessions;
  document.getElementById("recap-earned").textContent = fmt(earned);
  document.getElementById("recap-calibration").textContent = `×${cal.toFixed(2)}`;
  document.getElementById("recap-projected").textContent = fmt(projected);

  const msg = sessions >= 3
    ? `Peakr's model has calibrated to your earnings — every estimate now uses your real numbers.`
    : `Log a few more sessions and Peakr's model will calibrate to your actual earnings.`;
  document.getElementById("recap-cta-msg").textContent = msg;

  document.getElementById("recap").hidden = false;
}

function closeRecap(action) {
  state.trialRecapDismissed = true;
  document.getElementById("recap").hidden = true;
  if (action === "upgrade") {
    openPaywall();
  } else if (action === "referral") {
    openPaywall("referral");
  } else {
    state.tier = "free";
  }
  renderAll();
}

let currentShifts = [];

function renderAll() {
  const grid = buildWeeklyHeatmap();
  const slots = buildSlots(grid);

  let chosen, goalReached = true;
  if (state.planMode === "goal") {
    const r = selectByGoal(slots, state.incomeGoal);
    chosen = r.chosen;
    goalReached = r.reached;
  } else {
    chosen = selectByHours(slots, state.hoursPerWeek);
  }
  chosen = chosen.slice().sort(byTime);

  const shifts = groupShifts(chosen);
  currentShifts = shifts;
  renderHeatmap(grid);
  renderSchedule(shifts);
  renderPlanStatus(chosen.length, goalReached);
  renderComparison();
  renderZones();
  renderNowRecommendation();
  renderBonuses();
  renderEarningsLog();
  renderTrend();
  renderTaxTracker();
  renderOutlook();
  renderTier();
  saveState();
}

function renderPlanStatus(hoursPlanned, goalReached) {
  const el = document.getElementById("plan-status");
  if (!el) return;
  if (state.planMode === "goal") {
    if (goalReached) {
      el.className = "plan-status ok";
      el.textContent = `Goal of ${fmt(state.incomeGoal)}/wk take-home is reachable in about ${hoursPlanned} hour${hoursPlanned === 1 ? "" : "s"} of driving.`;
    } else {
      el.className = "plan-status warn";
      el.textContent = `Even driving every profitable hour this week, the schedule tops out below ${fmt(state.incomeGoal)}/wk take-home. Lower the goal, add platforms, or check fuel/MPG.`;
    }
  } else {
    el.className = "plan-status";
    el.textContent = `Showing the ${hoursPlanned} most profitable hours this week.`;
  }
}

// ---------------- Persistence ----------------

const STORAGE_KEY = "peakr.v1";
const INTRO_KEY = "peakr.introDismissed";

function serializeState() {
  return {
    market: state.market,
    weather: state.weather,
    event: state.event,
    planMode: state.planMode,
    hoursPerWeek: state.hoursPerWeek,
    incomeGoal: state.incomeGoal,
    vehicleMake: state.vehicleMake,
    vehicleModel: state.vehicleModel,
    vehicleYear: state.vehicleYear,
    mpg: state.mpg,
    mpgAuto: state.mpgAuto,
    fuelPrice: state.fuelPrice,
    fuelPriceCustom: state.fuelPriceCustom,
    incomeTaxRate: state.incomeTaxRate,
    selectedPlatforms: [...state.selectedPlatforms],
    earningsLog: state.earningsLog,
    expenses: state.expenses,
    tier: state.tier,
    proSource: state.proSource,
    trialStartedAt: state.trialStartedAt,
    trialRecapDismissed: state.trialRecapDismissed,
  };
}

function hydrateState(s) {
  if (!s || typeof s !== "object") return;
  if (s.market && MARKETS[s.market]) state.market = s.market;
  if (s.weather) state.weather = s.weather;
  if (s.event) state.event = s.event;
  if (s.planMode === "hours" || s.planMode === "goal") state.planMode = s.planMode;
  if (typeof s.hoursPerWeek === "number") state.hoursPerWeek = s.hoursPerWeek;
  if (typeof s.incomeGoal === "number") state.incomeGoal = s.incomeGoal;
  if (typeof s.vehicleMake === "string") state.vehicleMake = s.vehicleMake;
  if (typeof s.vehicleModel === "string") state.vehicleModel = s.vehicleModel;
  if (s.vehicleYear) state.vehicleYear = s.vehicleYear;
  if (typeof s.mpg === "number") state.mpg = s.mpg;
  if (typeof s.mpgAuto === "boolean") state.mpgAuto = s.mpgAuto;
  if (typeof s.fuelPrice === "number") state.fuelPrice = s.fuelPrice;
  if (typeof s.fuelPriceCustom === "boolean") state.fuelPriceCustom = s.fuelPriceCustom;
  if (typeof s.incomeTaxRate === "number") state.incomeTaxRate = s.incomeTaxRate;
  if (Array.isArray(s.selectedPlatforms) && s.selectedPlatforms.length) {
    state.selectedPlatforms = new Set(s.selectedPlatforms.filter(id => PLATFORMS[id]));
  }
  if (Array.isArray(s.earningsLog)) {
    state.earningsLog = s.earningsLog.filter(e =>
      e && PLATFORMS[e.platform] && typeof e.actualGross === "number" && typeof e.predictedGross === "number");
  }
  if (Array.isArray(s.expenses)) {
    state.expenses = s.expenses.filter(x => x && typeof x.amount === "number" && x.date && x.category);
  }
  if (s.tier === "free" || s.tier === "trial" || s.tier === "pro") state.tier = s.tier;
  if (s.proSource === "paid" || s.proSource === "referral") state.proSource = s.proSource;
  if (typeof s.trialStartedAt === "string") state.trialStartedAt = s.trialStartedAt;
  if (typeof s.trialRecapDismissed === "boolean") state.trialRecapDismissed = s.trialRecapDismissed;
  recomputeCalibration();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
  } catch (e) { /* storage unavailable; ignore */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    hydrateState(JSON.parse(raw));
  } catch (e) { /* corrupt snapshot; ignore */ }
}

// ---------------- Export ----------------

function nextDateForDay(dayIndex) {
  const now = new Date();
  const diff = (dayIndex - now.getDay() + 7) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  return d;
}

function exportCSV() {
  const lines = ["Day,Start,End,Platform,Hours,Est Net,Miles"];
  for (const s of currentShifts) {
    lines.push([
      DAYS[s.d],
      hourLabel(s.startHour),
      hourLabel(s.endHour % 24),
      PLATFORMS[s.id].name,
      s.hours,
      s.totalNet.toFixed(2),
      Math.round(s.totalMiles),
    ].join(","));
  }
  downloadFile("peakr-schedule.csv", "text/csv", lines.join("\n"));
}

function exportICS() {
  const pad = n => String(n).padStart(2, "0");
  const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}0000`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Peakr//Gig Optimizer//EN"];
  for (const s of currentShifts) {
    const base = nextDateForDay(s.d);
    const start = new Date(base); start.setHours(s.startHour, 0, 0, 0);
    const end = new Date(base); end.setHours(s.endHour, 0, 0, 0);
    lines.push(
      "BEGIN:VEVENT",
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:Drive ${PLATFORMS[s.id].name} (est. ${fmt(s.totalNet)})`,
      `DESCRIPTION:Peakr recommended shift — ~${fmt(s.totalNet / s.hours)}/hr net over ${Math.round(s.totalMiles)} mi`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  downloadFile("peakr-schedule.ics", "text/calendar", lines.join("\r\n"));
}

function downloadFile(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------- Earnings log & calibration ----------------

// Raw (uncalibrated) model gross for a contiguous block of hours.
function predictGross(platformId, dayIndex, startHour, hours) {
  let total = 0;
  for (let i = 0; i < hours; i++) {
    total += estimateHourlyEarnings(platformId, dayIndex, (startHour + i) % 24, { calibrated: false }).gross;
  }
  return total;
}

function recomputeCalibration() {
  let actual = 0, predicted = 0;
  for (const e of state.earningsLog) {
    actual += e.actualGross;
    predicted += e.predictedGross;
  }
  let factor = predicted > 0 ? actual / predicted : 1.0;
  factor = Math.min(3, Math.max(0.3, factor));   // guard against extreme outliers
  state.calibrationFactor = factor;
}

function dayOfWeekFromISO(iso) {
  return new Date(iso + "T12:00:00").getDay();
}

function addLogEntry({ date, platform, startHour, hours, actualGross }) {
  const day = dayOfWeekFromISO(date);
  const predictedGross = predictGross(platform, day, startHour, hours);
  const entry = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    date, platform, startHour, hours, actualGross, predictedGross,
  };
  state.earningsLog.push(entry);
  recomputeCalibration();
  if (API && API.enabled()) API.postSession({ ...entry, market: state.market });   // feed the flywheel
}

function deleteLogEntry(id) {
  state.earningsLog = state.earningsLog.filter(e => e.id !== id);
  recomputeCalibration();
}

function renderEarningsLog() {
  const tbody = document.getElementById("log-rows");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.earningsLog.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:14px 0">No sessions logged yet. Add one to calibrate the model to your real earnings.</td></tr>`;
  } else {
    const sorted = [...state.earningsLog].sort((a, b) => b.date.localeCompare(a.date));
    for (const e of sorted) {
      const p = PLATFORMS[e.platform];
      const variance = e.predictedGross > 0 ? (e.actualGross - e.predictedGross) / e.predictedGross : 0;
      const vcls = variance >= 0 ? "pos" : "neg";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${e.date}</td>
        <td class="cp-name"><span class="dot" style="background:${p ? p.color : "#888"}"></span>${p ? p.name : e.platform}</td>
        <td class="num muted">${e.hours}h @ ${hourLabel(e.startHour)}</td>
        <td class="num muted">${fmt(e.predictedGross)}</td>
        <td class="num">${fmt(e.actualGross)}</td>
        <td class="num ${vcls}">${variance >= 0 ? "+" : "−"}${Math.abs(variance * 100).toFixed(0)}%</td>
        <td><button class="btn-sm log-del" data-id="${e.id}" title="Delete">✕</button></td>
      `;
      tbody.appendChild(tr);
    }
  }
  tbody.querySelectorAll(".log-del").forEach(btn => {
    btn.addEventListener("click", () => { deleteLogEntry(btn.dataset.id); renderAll(); });
  });

  const f = state.calibrationFactor;
  const summary = document.getElementById("calibration-summary");
  if (summary) {
    if (!state.earningsLog.length) {
      summary.className = "plan-status";
      summary.textContent = "Calibration: model running on baseline estimates (×1.00).";
    } else {
      const pct = Math.round(Math.abs(1 - f) * 100);
      const dir = f < 1 ? "below" : "above";
      summary.className = "plan-status ok";
      summary.textContent = `Calibrated to your logs: your actual earnings run ${pct}% ${dir} the baseline model. All estimates now scaled ×${f.toFixed(2)}.`;
    }
  }
}

// ---------------- Expenses & year-to-date tax tracker ----------------

function currentYear() { return new Date().getFullYear(); }

function ytdBusinessMiles() {
  const yr = currentYear();
  let miles = 0;
  for (const e of state.earningsLog) {
    if (new Date(e.date + "T12:00:00").getFullYear() === yr) {
      miles += e.hours * milesPerHourFor(e.platform);
    }
  }
  return miles;
}

function ytdExpenses() {
  const yr = currentYear();
  return state.expenses
    .filter(x => new Date(x.date + "T12:00:00").getFullYear() === yr)
    .reduce((s, x) => s + x.amount, 0);
}

function addExpense({ date, category, amount }) {
  state.expenses.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), date, category, amount });
}

function deleteExpense(id) {
  state.expenses = state.expenses.filter(x => x.id !== id);
}

function renderTaxTracker() {
  const milesEl = document.getElementById("tt-miles");
  if (!milesEl) return;
  const miles = ytdBusinessMiles();
  const standard = miles * IRS_MILEAGE_RATE;
  const actual = ytdExpenses();
  const useStandard = standard >= actual;
  const deduction = Math.max(standard, actual);
  const marginalRate = SE_TAXABLE_PORTION * SE_TAX_RATE + state.incomeTaxRate;
  const savings = deduction * marginalRate;

  milesEl.textContent = Math.round(miles).toLocaleString() + " mi";
  document.getElementById("tt-standard").textContent = fmt(standard);
  document.getElementById("tt-actual").textContent = fmt(actual);
  document.getElementById("tt-standard-row").classList.toggle("winner", useStandard);
  document.getElementById("tt-actual-row").classList.toggle("winner", !useStandard);
  document.getElementById("tt-method").textContent = useStandard ? "Standard mileage" : "Actual expenses";
  document.getElementById("tt-savings").textContent = fmt(savings);
  document.getElementById("tt-deduction").textContent = fmt(deduction);

  const tbody = document.getElementById("expense-rows");
  tbody.innerHTML = "";
  if (!state.expenses.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:12px 0">No expenses logged yet. Track gas, maintenance, phone, etc. to compare against the mileage deduction.</td></tr>`;
  } else {
    const sorted = [...state.expenses].sort((a, b) => b.date.localeCompare(a.date));
    for (const x of sorted) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${x.date}</td>
        <td>${x.category}</td>
        <td class="num">${fmt(x.amount)}</td>
        <td><button class="btn-sm exp-del" data-id="${x.id}" title="Delete">✕</button></td>
      `;
      tbody.appendChild(tr);
    }
  }
  tbody.querySelectorAll(".exp-del").forEach(btn => {
    btn.addEventListener("click", () => { deleteExpense(btn.dataset.id); renderAll(); });
  });
}

// ---------------- Paste-to-import earnings ----------------

const PLATFORM_KEYWORDS = [
  ["ubereats", /uber\s*eats/i],
  ["uber", /uber/i],
  ["lyft", /lyft/i],
  ["doordash", /door\s*dash|dasher/i],
  ["grubhub", /grub\s*hub/i],
  ["instacart", /instacart/i],
  ["spark", /spark|walmart/i],
  ["amazonflex", /amazon\s*flex|flex/i],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseEarningsPaste(text) {
  const out = {};
  // Platform
  for (const [id, re] of PLATFORM_KEYWORDS) {
    if (re.test(text)) { out.platform = id; break; }
  }
  // Largest dollar amount = weekly total gross
  const amounts = [...text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)]
    .map(m => parseFloat(m[1].replace(/,/g, "")))
    .filter(n => !isNaN(n));
  if (amounts.length) out.gross = Math.max(...amounts);
  // Hours: "12.5 hr", "12 hours", "12h 30m", "Online 12:30"
  let hm = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b(?:\s*(\d+)\s*m)?/i);
  if (hm) {
    out.hours = parseFloat(hm[1]) + (hm[2] ? parseInt(hm[2], 10) / 60 : 0);
  }
  // Date: ISO, M/D[/Y], or "May 18"
  let dm = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (dm) {
    out.date = dm[1];
  } else if ((dm = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const y = dm[3] ? (dm[3].length === 2 ? "20" + dm[3] : dm[3]) : String(currentYear());
    out.date = `${y}-${String(+dm[1]).padStart(2, "0")}-${String(+dm[2]).padStart(2, "0")}`;
  } else if ((dm = text.match(new RegExp("\\b(" + MONTHS.join("|") + ")[a-z]*\\.?\\s+(\\d{1,2})\\b", "i")))) {
    const mo = MONTHS.indexOf(dm[1].slice(0, 3).toLowerCase()) + 1;
    out.date = `${currentYear()}-${String(mo).padStart(2, "0")}-${String(+dm[2]).padStart(2, "0")}`;
  }
  return out;
}

// ---------------- Shareable setup link ----------------

function buildShareLink() {
  const snapshot = serializeState();
  const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(snapshot)))));
  const base = location.href.split("#")[0];
  return `${base}#s=${encoded}`;
}

function applyShareLink() {
  const hash = location.hash;
  if (!hash.startsWith("#s=")) return false;
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(hash.slice(3)))));
    hydrateState(JSON.parse(json));
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------- 7-day weather + events outlook ----------------

// FNV-1a with a final avalanche mix — gives a well-distributed 32-bit value
// so derived probabilities vary by date rather than being dominated by the
// (shared) market-name prefix.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}

const WEATHER_ICON = {
  clear: "☀️", cloudy: "⛅", rain: "🌧️", storm: "⛈️", snow: "❄️", hot: "🔥",
};

// Map WMO weather codes (Open-Meteo) to our model's weather categories.
function wmoToKey(code, tmaxF) {
  if (typeof tmaxF === "number" && tmaxF >= 95) return "hot";
  if ([95, 96, 99].includes(code)) return "storm";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([2, 3, 45, 48].includes(code)) return "cloudy";
  if ([0, 1].includes(code)) return "clear";
  return "cloudy";
}

async function fetchForecast(marketId) {
  const m = MARKETS[marketId];
  const c = m.center;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&timezone=auto&forecast_days=7`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("weather " + res.status);
    const j = await res.json();
    const d = j.daily;
    return d.time.map((date, i) => ({
      date,
      weatherKey: wmoToKey(d.weather_code[i], d.temperature_2m_max[i]),
      tempMax: Math.round(d.temperature_2m_max[i]),
      tempMin: Math.round(d.temperature_2m_min[i]),
      precip: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      live: true,
    }));
  } finally {
    clearTimeout(timer);
  }
}

// Deterministic offline fallback so the app works without network access.
function mockForecast(marketId) {
  const pattern = ["clear", "clear", "cloudy", "rain", "cloudy", "clear", "hot"];
  const today = new Date();
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(today);
    dt.setDate(today.getDate() + i);
    const date = dt.toISOString().slice(0, 10);
    const h = hashStr(marketId + date);
    const weatherKey = pattern[(h + i) % pattern.length];
    const tempMax = 52 + (h % 38);
    return {
      date, weatherKey, tempMax, tempMin: tempMax - 14,
      precip: weatherKey === "rain" ? 70 : weatherKey === "storm" ? 85 : 10,
      live: false,
    };
  });
}

// Simulated upcoming big events (no public ticketing API is CORS-accessible).
function eventsForDates(marketId, dates) {
  const venues = MARKETS[marketId].venues || [];
  const out = {};
  if (!venues.length) return out;
  for (const date of dates) {
    const day = new Date(date + "T12:00:00").getDay();
    const h = hashStr(marketId + "|" + date);
    const weekendBoost = (day === 5 || day === 6 || day === 0);
    const threshold = weekendBoost ? 0.62 : 0.28;
    if ((h % 1000) / 1000 < threshold) {
      const v = venues[h % venues.length];
      const type = v.types[(h >>> 3) % v.types.length];
      out[date] = { name: v.name, type };
    }
  }
  return out;
}

// ---------------- Account & cross-device sync (Phase 3) ----------------

function showSignedIn(email) {
  document.getElementById("account-signedout").hidden = true;
  const si = document.getElementById("account-signedin");
  si.hidden = false;
  document.getElementById("account-email-label").textContent = email;
}

// Merge the account's server-side history into local state (dedupe by id).
async function pullAndMerge() {
  const [sessions, expenses] = await Promise.all([API.pullSessions(), API.pullExpenses()]);
  const haveS = new Set(state.earningsLog.map(e => e.id));
  for (const s of sessions) if (!haveS.has(s.id)) state.earningsLog.push(s);
  const haveE = new Set(state.expenses.map(x => x.id));
  for (const x of expenses) if (!haveE.has(x.id)) state.expenses.push(x);
  recomputeCalibration();
  renderAll();
}

async function initAccount() {
  if (!API || !API.enabled()) return;
  document.getElementById("account").style.display = "";
  await API.ensureToken();
  const who = await API.me();
  if (who && who.email) {
    showSignedIn(who.email);
    await pullAndMerge();          // hydrate this device from the account
  }
}

function wireAccount() {
  const panel = document.getElementById("account-panel");
  document.getElementById("account-btn").addEventListener("click", () => { panel.hidden = !panel.hidden; });

  document.getElementById("account-send").addEventListener("click", async () => {
    const email = document.getElementById("account-email").value.trim();
    const msg = document.getElementById("account-msg");
    if (!/.+@.+\..+/.test(email)) { msg.textContent = "Enter a valid email."; return; }
    msg.textContent = "Sending…";
    const res = await API.requestEmailCode(email);
    if (!res) { msg.textContent = "Couldn't send a code — check your connection."; return; }
    document.getElementById("account-code-row").hidden = false;
    msg.textContent = res.dev_code ? `Dev mode: your code is ${res.dev_code}` : "Code sent — check your email.";
  });

  document.getElementById("account-verify").addEventListener("click", async () => {
    const email = document.getElementById("account-email").value.trim();
    const code = document.getElementById("account-code").value.trim();
    const msg = document.getElementById("account-msg");
    msg.textContent = "Verifying…";
    const res = await API.verifyEmailCode(email, code);
    if (!res || !res.email) { msg.textContent = "Wrong or expired code."; return; }
    showSignedIn(res.email);
    await pullAndMerge();
    setTimeout(() => { panel.hidden = true; }, 800);
  });
}

// Pull the live community model from the backend (when configured) and let it
// override the seeded data. No-op when the backend feature flag is off.
async function syncMarketModel() {
  if (!API || !API.enabled()) return;
  const market = state.market;
  const model = await API.fetchMarketModel(market);
  if (model && market === state.market) {
    setMarketModel(market, model);
    renderAll();
  }
}

async function loadForecast() {
  const marketId = state.market;
  let days, sourceLabel, eventsMerged = false;

  // Prefer the backend proxy (real weather + Ticketmaster events, cached) when on.
  if (API && API.enabled()) {
    const proxied = await API.fetchForecast(marketId);
    if (proxied && proxied.days.length) {
      days = proxied.days;            // events already merged onto each day server-side
      eventsMerged = true;
      sourceLabel = "live · Peakr API";
    }
  }
  if (!days) {
    try {
      days = await fetchForecast(marketId);
      sourceLabel = "live · Open-Meteo";
    } catch (e) {
      days = mockForecast(marketId);
      sourceLabel = "simulated (live weather unavailable)";
    }
  }
  if (marketId !== state.market) return;   // market changed mid-fetch; drop stale result
  if (!eventsMerged) {
    const events = eventsForDates(marketId, days.map(d => d.date));
    days.forEach(d => { d.event = events[d.date] || null; });
  }
  state.forecast = days;
  const src = document.getElementById("forecast-source");
  if (src) src.textContent = sourceLabel;
  renderOutlook();
}

// Best platform and projected net for a representative ~8h shift on a given day.
function projectDay(dayIndex, weatherKey, eventKey) {
  let best = null;
  for (const id of state.selectedPlatforms) {
    const nets = [];
    for (let h = 0; h < 24; h++) {
      nets.push(estimateHourlyEarnings(id, dayIndex, h, { weather: weatherKey, event: eventKey }).net);
    }
    nets.sort((a, b) => b - a);
    const projected = nets.slice(0, 8).reduce((s, x) => s + x, 0);
    if (!best || projected > best.projected) best = { id, projected };
  }
  return best;
}

function renderOutlook() {
  const strip = document.getElementById("outlook-strip");
  if (!strip) return;
  strip.innerHTML = "";
  if (!state.forecast.length) {
    strip.innerHTML = `<div class="muted" style="padding:12px">Loading forecast…</div>`;
    return;
  }

  let maxProj = 0;
  const computed = state.forecast.map(d => {
    const dayIndex = new Date(d.date + "T12:00:00").getDay();
    const eventKey = d.event ? d.event.type : "none";
    const best = projectDay(dayIndex, d.weatherKey, eventKey);
    const baseline = best ? projectDay(dayIndex, "clear", "none") : null;
    const uplift = best && baseline && baseline.projected > 0
      ? (best.projected - baseline.projected) / baseline.projected : 0;
    if (best && best.projected > maxProj) maxProj = best.projected;
    return { d, dayIndex, best, uplift };
  });

  for (const c of computed) {
    const { d, dayIndex, best, uplift } = c;
    const dt = new Date(d.date + "T12:00:00");
    const intensity = maxProj > 0 && best ? best.projected / maxProj : 0;
    const p = best ? PLATFORMS[best.id] : null;
    const upliftHtml = Math.abs(uplift) >= 0.03
      ? `<span class="ou-uplift ${uplift >= 0 ? "pos" : "neg"}">${uplift >= 0 ? "+" : "−"}${Math.abs(uplift * 100).toFixed(0)}%</span>`
      : "";
    const eventHtml = d.event
      ? `<div class="ou-event" title="Simulated local event">${d.event.name}</div>`
      : `<div class="ou-event muted">—</div>`;
    const card = document.createElement("div");
    card.className = "ou-card";
    card.style.setProperty("--i", intensity.toFixed(2));
    card.innerHTML = `
      <div class="ou-day">${DAYS[dayIndex].slice(0, 3)} <span class="muted">${dt.getMonth() + 1}/${dt.getDate()}</span></div>
      <div class="ou-wx"><span class="ou-icon">${WEATHER_ICON[d.weatherKey] || "•"}</span> ${WEATHER_MODIFIERS[d.weatherKey].label}</div>
      <div class="ou-temp muted">${d.tempMax}° / ${d.tempMin}°${d.precip != null ? ` · ${d.precip}%☔` : ""}</div>
      ${eventHtml}
      <div class="ou-best">
        ${p ? `<span class="dot" style="background:${p.color}"></span>${p.name}` : "—"}
      </div>
      <div class="ou-proj">${best ? fmt(best.projected) : "—"} ${upliftHtml}<div class="muted ou-sub">est. 8h shift</div></div>
    `;
    strip.appendChild(card);
  }
}

// ---------------- Week-over-week earnings trend ----------------

function weekStartISO(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const dow = (d.getDay() + 6) % 7;   // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

function renderTrend() {
  const wrap = document.getElementById("trend-bars");
  const note = document.getElementById("trend-note");
  if (!wrap) return;

  const byWeek = {};
  for (const e of state.earningsLog) {
    const wk = weekStartISO(e.date);
    if (!byWeek[wk]) byWeek[wk] = { gross: 0, hours: 0 };
    byWeek[wk].gross += e.actualGross;
    byWeek[wk].hours += e.hours;
  }
  const weeks = Object.keys(byWeek).sort();
  wrap.innerHTML = "";

  if (weeks.length === 0) {
    wrap.innerHTML = `<div class="muted" style="padding:8px 0">Log earnings across multiple weeks to see your trend.</div>`;
    if (note) note.textContent = "";
    return;
  }

  const recent = weeks.slice(-8);
  const max = Math.max(...recent.map(w => byWeek[w].gross));
  const bestWeek = recent.reduce((b, w) => byWeek[w].gross > byWeek[b].gross ? w : b, recent[0]);

  for (const w of recent) {
    const v = byWeek[w];
    const pct = max > 0 ? (v.gross / max) * 100 : 0;
    const dt = new Date(w + "T12:00:00");
    const isBest = w === bestWeek;
    const perHr = v.hours > 0 ? v.gross / v.hours : 0;
    const bar = document.createElement("div");
    bar.className = "trend-bar" + (isBest ? " best" : "");
    bar.title = `Week of ${w}: ${fmt(v.gross)} over ${v.hours}h (${fmt(perHr)}/hr)`;
    bar.innerHTML = `
      <div class="tb-val">${fmt(v.gross)}</div>
      <div class="tb-col"><span style="height:${Math.max(4, pct).toFixed(0)}%"></span></div>
      <div class="tb-label muted">${dt.getMonth() + 1}/${dt.getDate()}</div>
    `;
    wrap.appendChild(bar);
  }

  if (note) {
    const bw = byWeek[bestWeek];
    let msg = `Best week: ${fmt(bw.gross)} (week of ${bestWeek}).`;
    if (recent.length >= 2) {
      const last = byWeek[recent[recent.length - 1]].gross;
      const prev = byWeek[recent[recent.length - 2]].gross;
      if (prev > 0) {
        const wow = (last - prev) / prev;
        msg += ` Latest week ${wow >= 0 ? "up" : "down"} ${Math.abs(wow * 100).toFixed(0)}% week-over-week.`;
      }
    }
    note.textContent = msg;
  }
}

function populateVehicleMakes() {
  const sel = document.getElementById("v-make");
  sel.innerHTML = `<option value="">— select make —</option>`;
  for (const make of vehicleMakes()) {
    const opt = document.createElement("option");
    opt.value = make; opt.textContent = make;
    sel.appendChild(opt);
  }
}

function populateVehicleModels(make) {
  const sel = document.getElementById("v-model");
  sel.innerHTML = `<option value="">— select model —</option>`;
  for (const model of vehicleModels(make)) {
    const opt = document.createElement("option");
    opt.value = model; opt.textContent = model;
    sel.appendChild(opt);
  }
  sel.disabled = !make;
}

function populateVehicleYears(make, model) {
  const sel = document.getElementById("v-year");
  sel.innerHTML = `<option value="">— year —</option>`;
  for (const year of vehicleYears(make, model)) {
    const opt = document.createElement("option");
    opt.value = year; opt.textContent = year;
    sel.appendChild(opt);
  }
  sel.disabled = !(make && model);
}

function updateMPGFromLookup() {
  const { vehicleMake, vehicleModel, vehicleYear } = state;
  const mpgInput = document.getElementById("v-mpg");
  const src = document.getElementById("v-mpg-source");
  if (vehicleMake && vehicleModel && vehicleYear) {
    const mpg = lookupMPG(vehicleMake, vehicleModel, vehicleYear);
    if (mpg != null) {
      state.mpg = mpg; state.mpgAuto = true;
      mpgInput.value = mpg;
      src.textContent = "EPA";
      src.className = "hint auto";
      return;
    }
  }
  state.mpgAuto = false;
  src.textContent = "manual";
  src.className = "hint";
}

function wireControls() {
  document.getElementById("market").addEventListener("change", e => {
    state.market = e.target.value;
    if (!state.fuelPriceCustom) {
      state.fuelPrice = MARKETS[state.market].fuelCost;
      document.getElementById("v-fuel").value = state.fuelPrice.toFixed(2);
    }
    state.forecast = [];
    loadForecast();
    syncMarketModel();
    renderAll();
  });
  document.getElementById("weather").addEventListener("change", e => {
    state.weather = e.target.value; renderAll();
  });
  document.getElementById("event").addEventListener("change", e => {
    state.event = e.target.value; renderAll();
  });
  document.getElementById("hours").addEventListener("input", e => {
    state.hoursPerWeek = parseInt(e.target.value, 10);
    document.getElementById("hours-val").textContent = state.hoursPerWeek + " hrs/week";
    renderAll();
  });
  document.getElementById("income-goal").addEventListener("input", e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) { state.incomeGoal = v; renderAll(); }
  });
  document.querySelectorAll("#plan-mode .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mode === "goal" && !isPro()) {
        openPaywall("feature", "Income goal planner");
        return;
      }
      state.planMode = btn.dataset.mode;
      applyPlanMode();
      renderAll();
    });
  });

  document.getElementById("v-make").addEventListener("change", e => {
    state.vehicleMake = e.target.value;
    state.vehicleModel = ""; state.vehicleYear = null;
    populateVehicleModels(state.vehicleMake);
    populateVehicleYears(state.vehicleMake, state.vehicleModel);
    updateMPGFromLookup();
    renderAll();
  });
  document.getElementById("v-model").addEventListener("change", e => {
    state.vehicleModel = e.target.value;
    state.vehicleYear = null;
    populateVehicleYears(state.vehicleMake, state.vehicleModel);
    updateMPGFromLookup();
    renderAll();
  });
  document.getElementById("v-year").addEventListener("change", e => {
    state.vehicleYear = e.target.value ? parseInt(e.target.value, 10) : null;
    updateMPGFromLookup();
    renderAll();
  });
  document.getElementById("v-mpg").addEventListener("input", e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      state.mpg = v;
      state.mpgAuto = false;
      const src = document.getElementById("v-mpg-source");
      src.textContent = "manual"; src.className = "hint";
      renderAll();
    }
  });

  document.getElementById("v-fuel").addEventListener("input", e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      state.fuelPrice = v;
      state.fuelPriceCustom = true;
      renderAll();
    }
  });
  document.getElementById("v-fuel-reset").addEventListener("click", () => {
    state.fuelPrice = MARKETS[state.market].fuelCost;
    state.fuelPriceCustom = false;
    document.getElementById("v-fuel").value = state.fuelPrice.toFixed(2);
    renderAll();
  });

  document.getElementById("tax-rate").addEventListener("change", e => {
    state.incomeTaxRate = parseFloat(e.target.value); renderAll();
  });

  document.getElementById("export-csv").addEventListener("click", () => {
    if (!isPro()) { openPaywall("feature", "Schedule export"); return; }
    exportCSV();
  });
  document.getElementById("export-ics").addEventListener("click", () => {
    if (!isPro()) { openPaywall("feature", "Schedule export"); return; }
    exportICS();
  });

  document.getElementById("log-add").addEventListener("click", () => {
    const date = document.getElementById("log-date").value;
    const platform = document.getElementById("log-platform").value;
    const startHour = parseInt(document.getElementById("log-start").value, 10);
    const hours = parseFloat(document.getElementById("log-hours").value);
    const actualGross = parseFloat(document.getElementById("log-gross").value);
    const err = document.getElementById("log-error");
    if (!date || !platform || isNaN(startHour) || !(hours > 0) || !(actualGross >= 0)) {
      err.textContent = "Enter date, platform, start hour, hours, and actual earnings.";
      return;
    }
    err.textContent = "";
    addLogEntry({ date, platform, startHour, hours, actualGross });
    document.getElementById("log-gross").value = "";
    document.getElementById("log-hours").value = "";
    renderAll();
  });

  document.getElementById("share-link").addEventListener("click", async () => {
    const url = buildShareLink();
    history.replaceState(null, "", url);
    const btn = document.getElementById("share-link");
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "Link copied!";
    } catch (e) {
      btn.textContent = "Link in address bar";
    }
    setTimeout(() => { btn.textContent = original; }, 1800);
  });

  document.getElementById("exp-add").addEventListener("click", () => {
    const date = document.getElementById("exp-date").value;
    const category = document.getElementById("exp-category").value;
    const amount = parseFloat(document.getElementById("exp-amount").value);
    if (!date || !category || !(amount > 0)) return;
    addExpense({ date, category, amount });
    if (API && API.enabled()) API.postExpense({ date, category, amount });
    document.getElementById("exp-amount").value = "";
    renderAll();
  });

  document.getElementById("paste-parse").addEventListener("click", () => {
    const text = document.getElementById("paste-input").value;
    const result = document.getElementById("paste-result");
    if (!text.trim()) { result.textContent = "Paste your summary text first."; return; }
    const parsed = parseEarningsPaste(text);
    const filled = [];
    if (parsed.date) { document.getElementById("log-date").value = parsed.date; filled.push("date"); }
    if (parsed.platform) { document.getElementById("log-platform").value = parsed.platform; filled.push("app"); }
    if (parsed.hours) { document.getElementById("log-hours").value = parsed.hours.toFixed(1); filled.push("hours"); }
    if (parsed.gross) { document.getElementById("log-gross").value = parsed.gross.toFixed(2); filled.push("earnings"); }
    result.textContent = filled.length
      ? `Found ${filled.join(", ")}. Review the form below, then click "Log it".`
      : "Couldn't read that — try entering it manually below.";
  });

  document.getElementById("alerts-toggle").addEventListener("click", () => {
    if (!isPro()) { openPaywall("feature", "Surge alerts"); return; }
    toggleSurgeAlerts();
  });

  document.getElementById("intro-dismiss").addEventListener("click", () => {
    document.getElementById("intro").style.display = "none";
    try { localStorage.setItem(INTRO_KEY, "1"); } catch (e) { /* ignore */ }
  });

  // --- Plans / paywall / trial recap ---
  const plansBtn = document.getElementById("plans-btn");
  if (plansBtn) plansBtn.addEventListener("click", () => openPaywall());
  const paywallClose = document.getElementById("paywall-close");
  if (paywallClose) paywallClose.addEventListener("click", closePaywall);
  const paywall = document.getElementById("paywall");
  if (paywall) paywall.addEventListener("click", e => { if (e.target === paywall) closePaywall(); });
  const trialBtn = document.getElementById("trial-start");
  if (trialBtn) trialBtn.addEventListener("click", startTrial);
  const proBuy = document.getElementById("pro-buy");
  if (proBuy) proBuy.addEventListener("click", upgradePro);
  const refShow = document.getElementById("referral-show");
  if (refShow) refShow.addEventListener("click", () => {
    closePaywall();
    const panel = document.getElementById("bonus-panel");
    if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  const rc = document.getElementById("recap-continue-free");
  if (rc) rc.addEventListener("click", () => closeRecap("free"));
  const ru = document.getElementById("recap-upgrade");
  if (ru) ru.addEventListener("click", () => closeRecap("upgrade"));
  const rr = document.getElementById("recap-referral");
  if (rr) rr.addEventListener("click", () => closeRecap("referral"));

  document.getElementById("tier-toggle").addEventListener("click", () => {
    state.tier = state.tier === "pro" ? "free" : "pro"; renderAll();
  });
}

// ---------------- Surge alerts (local, while the app is open) ----------------

let alertsOn = false;
let alertTimer = null;
const firedAlerts = new Set();

async function toggleSurgeAlerts() {
  const btn = document.getElementById("alerts-toggle");
  if (alertsOn) {
    alertsOn = false;
    if (alertTimer) clearInterval(alertTimer);
    btn.textContent = "🔔 Surge alerts";
    btn.classList.remove("primary");
    return;
  }
  if (!("Notification" in window)) {
    btn.textContent = "Alerts not supported";
    return;
  }
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") {
    btn.textContent = "🔔 Alerts blocked";
    return;
  }
  alertsOn = true;
  btn.textContent = "🔔 Alerts on";
  btn.classList.add("primary");
  checkSurge();
  alertTimer = setInterval(checkSurge, 60000);   // re-check every minute while open
}

// Fire a notification when demand for a selected app is about to jump.
function checkSurge() {
  if (!alertsOn || Notification.permission !== "granted") return;
  const now = new Date();
  const d = now.getDay();
  const h = now.getHours();
  const next = (h + 1) % 24;
  const nextDay = next === 0 ? (d + 1) % 7 : d;

  let best = null;
  for (const id of state.selectedPlatforms) {
    const nowEst = estimateHourlyEarnings(id, d, h);
    const soonEst = estimateHourlyEarnings(id, nextDay, next);
    if (soonEst.demand >= 1.7 && soonEst.demand > nowEst.demand + 0.3) {
      if (!best || soonEst.net > best.net) best = { id, net: soonEst.net, demand: soonEst.demand };
    }
  }
  if (!best) return;
  const key = `${nextDay}-${next}-${best.id}`;
  if (firedAlerts.has(key)) return;
  firedAlerts.add(key);

  const p = PLATFORMS[best.id];
  const zones = recommendZones(nextDay, next);
  const where = zones.length ? ` near ${zones[0].name}` : "";
  try {
    new Notification(`Surge incoming: ${p.name}`, {
      body: `Demand jumps around ${hourLabel(next)}${where} — about ${fmt(best.net)}/hr. Get positioned.`,
      icon: "icon.svg",
      tag: key,
    });
  } catch (e) { /* notification failed; ignore */ }
}

function populateLogPlatforms() {
  const sel = document.getElementById("log-platform");
  sel.innerHTML = "";
  for (const [id, p] of Object.entries(PLATFORMS)) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = p.name;
    sel.appendChild(opt);
  }
  const start = document.getElementById("log-start");
  start.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement("option");
    opt.value = h; opt.textContent = hourLabel(h);
    start.appendChild(opt);
  }
  start.value = "17";

  const cat = document.getElementById("exp-category");
  cat.innerHTML = "";
  for (const c of EXPENSE_CATEGORIES) {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c;
    cat.appendChild(opt);
  }
}

function applyPlanMode() {
  const isGoal = state.planMode === "goal";
  document.getElementById("plan-hours").style.display = isGoal ? "none" : "block";
  document.getElementById("plan-goal").style.display = isGoal ? "block" : "none";
  document.querySelectorAll("#plan-mode .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === state.planMode);
  });
}

// Reflect restored state into the form controls and dependent dropdowns.
function applyStateToControls() {
  document.getElementById("market").value = state.market;
  document.getElementById("weather").value = state.weather;
  document.getElementById("event").value = state.event;
  document.getElementById("hours").value = state.hoursPerWeek;
  document.getElementById("income-goal").value = state.incomeGoal;
  document.getElementById("tax-rate").value = String(state.incomeTaxRate);
  applyPlanMode();

  document.getElementById("v-make").value = state.vehicleMake || "";
  populateVehicleModels(state.vehicleMake);
  document.getElementById("v-model").value = state.vehicleModel || "";
  populateVehicleYears(state.vehicleMake, state.vehicleModel);
  if (state.vehicleYear) document.getElementById("v-year").value = String(state.vehicleYear);
  updateMPGFromLookup();
  if (!state.mpgAuto) document.getElementById("v-mpg").value = state.mpg;

  document.getElementById("v-fuel").value = state.fuelPrice.toFixed(2);
  renderPlatformChoices();
}

document.addEventListener("DOMContentLoaded", () => {
  // A share link takes precedence over locally saved settings.
  if (!applyShareLink()) loadState();
  renderMarketOptions();
  renderPlatformChoices();
  populateVehicleMakes();
  populateVehicleModels("");
  populateVehicleYears("", "");
  populateLogPlatforms();
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("log-date").value = today;
  document.getElementById("exp-date").value = today;
  document.getElementById("v-fuel").value = state.fuelPrice.toFixed(2);
  document.getElementById("v-mpg").value = state.mpg;
  applyStateToControls();
  wireControls();
  try {
    if (localStorage.getItem(INTRO_KEY) === "1") document.getElementById("intro").style.display = "none";
  } catch (e) { /* ignore */ }
  document.getElementById("hours-val").textContent = state.hoursPerWeek + " hrs/week";
  wireAccount();
  renderAll();
  // If the trial just expired and we haven't shown the recap yet, surface it.
  if (state.tier === "trial" && trialDaysLeft() === 0 && !state.trialRecapDismissed) {
    showRecap();
  }
  loadForecast();
  syncMarketModel();
  initAccount();
});

// Dev/test helper: programmatically set the tier without going through the
// paywall UI. Used by automated tests; harmless in production.
window.__setTier = function (t) {
  if (t === "pro" || t === "trial" || t === "free") {
    state.tier = t;
    if (t === "trial" && !state.trialStartedAt) state.trialStartedAt = new Date().toISOString();
    renderAll();
  }
};

// Register the service worker so Peakr is installable and works offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* SW unavailable; app still works */ });
  });
}
