// Gig Economy Optimizer — recommendation engine and UI controller.

const { PLATFORMS, MARKETS, WEATHER_MODIFIERS, EVENT_BOOSTS, DAYS, curveForDay } = window.GIG_DATA;
const { vehicleMakes, vehicleModels, vehicleYears, lookupMPG } = window.VEHICLES;

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

const state = {
  market: "nyc",
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
  fuelPrice: MARKETS.nyc.fuelCost,
  fuelPriceCustom: false,
  incomeTaxRate: 0.12,
  acceptanceRate: 0.85,
  selectedPlatforms: new Set(Object.keys(PLATFORMS)),
  earningsLog: [],          // [{ id, date, platform, startHour, hours, actualGross, predictedGross }]
  calibrationFactor: 1.0,   // derived: total actual / total predicted across the log
  forecast: [],             // 7-day outlook: [{ date, weatherKey, tempMax, tempMin, precip, event, live }]
  tier: "free",
};

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
  if (calibrated) gross *= state.calibrationFactor;

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
    ["Gross earnings", gross, "pos"],
    ["Fuel", -fuel, "neg"],
    ["Vehicle wear & maintenance", -wear, "neg"],
    ["Self-employment tax (15.3%)", -tax.seTax, "neg"],
    [`Income tax (${Math.round(state.incomeTaxRate * 100)}%)`, -tax.incomeTax, "neg"],
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
    card.innerHTML = `<p class="muted">Select at least one platform to see recommendations.</p>`;
    return;
  }
  const p = PLATFORMS[best.id];
  card.innerHTML = `
    <div class="now-platform" style="--c:${p.color}">
      <div class="now-badge" style="background:${p.color}">${p.name[0]}</div>
      <div>
        <div class="now-title">Run ${p.name} right now</div>
        <div class="now-sub muted">${DAYS[d]} ${hourLabel(h)} · demand ${best.est.demand.toFixed(2)}× · surge ${best.est.surge.toFixed(2)}×</div>
      </div>
      <div class="now-earn">
        <div class="big">${fmt(best.est.net)}<span class="muted">/hr net</span></div>
        <div class="muted">gross ${fmt(best.est.gross)}/hr</div>
      </div>
    </div>
  `;
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

function renderTier() {
  const isPro = state.tier === "pro";
  document.body.classList.toggle("pro", isPro);
  document.querySelectorAll(".pro-lock").forEach(el => {
    el.style.display = isPro ? "none" : "flex";
  });
  document.getElementById("tier-label").textContent = isPro ? "Pro Subscriber" : "Free Preview";
  document.getElementById("tier-toggle").textContent = isPro ? "Switch to Free" : "Upgrade to Pro (Demo)";
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
  renderEarningsLog();
  renderTrend();
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

const STORAGE_KEY = "shiftsmart.v1";

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
    tier: state.tier,
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
  if (s.tier) state.tier = s.tier;
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
  downloadFile("shiftsmart-schedule.csv", "text/csv", lines.join("\n"));
}

function exportICS() {
  const pad = n => String(n).padStart(2, "0");
  const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}0000`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ShiftSmart//Gig Optimizer//EN"];
  for (const s of currentShifts) {
    const base = nextDateForDay(s.d);
    const start = new Date(base); start.setHours(s.startHour, 0, 0, 0);
    const end = new Date(base); end.setHours(s.endHour, 0, 0, 0);
    lines.push(
      "BEGIN:VEVENT",
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:Drive ${PLATFORMS[s.id].name} (est. ${fmt(s.totalNet)})`,
      `DESCRIPTION:ShiftSmart recommended shift — ~${fmt(s.totalNet / s.hours)}/hr net over ${Math.round(s.totalMiles)} mi`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  downloadFile("shiftsmart-schedule.ics", "text/calendar", lines.join("\r\n"));
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
  state.earningsLog.push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    date, platform, startHour, hours, actualGross, predictedGross,
  });
  recomputeCalibration();
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

async function loadForecast() {
  const marketId = state.market;
  let days;
  let sourceLabel;
  try {
    days = await fetchForecast(marketId);
    sourceLabel = "live · Open-Meteo";
  } catch (e) {
    days = mockForecast(marketId);
    sourceLabel = "simulated (live weather unavailable)";
  }
  if (marketId !== state.market) return;   // market changed mid-fetch; drop stale result
  const events = eventsForDates(marketId, days.map(d => d.date));
  days.forEach(d => { d.event = events[d.date] || null; });
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

  document.getElementById("export-csv").addEventListener("click", exportCSV);
  document.getElementById("export-ics").addEventListener("click", exportICS);

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

  document.getElementById("tier-toggle").addEventListener("click", () => {
    state.tier = state.tier === "pro" ? "free" : "pro"; renderAll();
  });
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
  document.getElementById("v-fuel").value = state.fuelPrice.toFixed(2);
  document.getElementById("v-mpg").value = state.mpg;
  applyStateToControls();
  wireControls();
  document.getElementById("hours-val").textContent = state.hoursPerWeek + " hrs/week";
  renderAll();
  loadForecast();
});
