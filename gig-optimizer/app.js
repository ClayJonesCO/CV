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

function estimateHourlyEarnings(platformId, dayIndex, hour) {
  const p = PLATFORMS[platformId];
  const market = MARKETS[state.market];
  const curve = curveForDay(platformId, dayIndex);
  const demand = curve[hour];
  const category = TYPE_TO_CATEGORY[p.type];
  const weatherMod = WEATHER_MODIFIERS[state.weather][category] || 1.0;
  const eventMod = EVENT_BOOSTS[state.event][category] || 1.0;

  const surge = Math.min(p.surgeCeiling, Math.max(1.0, demand));
  const base = p.baselineHourly * market.multiplier;
  const gross = base * surge * weatherMod * eventMod;

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

function saveState() {
  try {
    const snapshot = {
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
      tier: state.tier,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (e) { /* storage unavailable; ignore */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
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
    if (s.tier) state.tier = s.tier;
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

  document.getElementById("tier-toggle").addEventListener("click", () => {
    state.tier = state.tier === "pro" ? "free" : "pro"; renderAll();
  });
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
  loadState();
  renderMarketOptions();
  renderPlatformChoices();
  populateVehicleMakes();
  populateVehicleModels("");
  populateVehicleYears("", "");
  document.getElementById("v-fuel").value = state.fuelPrice.toFixed(2);
  document.getElementById("v-mpg").value = state.mpg;
  applyStateToControls();
  wireControls();
  document.getElementById("hours-val").textContent = state.hoursPerWeek + " hrs/week";
  renderAll();
});
