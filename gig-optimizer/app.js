// Gig Economy Optimizer — recommendation engine and UI controller.

const { PLATFORMS, MARKETS, WEATHER_MODIFIERS, EVENT_BOOSTS, DAYS, curveForDay } = window.GIG_DATA;

const TYPE_TO_CATEGORY = {
  "rideshare": "rideshare",
  "food-delivery": "delivery",
  "grocery": "grocery",
  "package": "delivery",
};

const state = {
  market: "nyc",
  weather: "clear",
  event: "none",
  hoursPerWeek: 30,
  vehicle: "car",
  acceptanceRate: 0.85,
  selectedPlatforms: new Set(Object.keys(PLATFORMS)),
  tier: "free",
};

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
  const milesPerHour = p.type === "rideshare" ? 22 : 18;
  const mpg = state.vehicle === "ev" ? 100 : state.vehicle === "hybrid" ? 45 : 26;
  const fuelCost = (milesPerHour / mpg) * market.fuelCost;
  const wearCost = milesPerHour * 0.09;

  const net = gross - fuelCost - wearCost;
  return {
    gross: Math.max(0, gross),
    net: Math.max(0, net),
    surge,
    demand,
  };
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

function recommendSchedule(grid, hoursTarget) {
  const slots = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const b = grid[d][h];
      if (b) slots.push({ d, h, ...b });
    }
  }
  slots.sort((a, b) => b.est.net - a.est.net);
  const chosen = slots.slice(0, hoursTarget);
  chosen.sort((a, b) => a.d * 24 + a.h - (b.d * 24 + b.h));
  return chosen;
}

function groupShifts(chosen) {
  const shifts = [];
  let cur = null;
  for (const s of chosen) {
    if (cur && cur.d === s.d && cur.endHour === s.h && cur.id === s.id) {
      cur.endHour = s.h + 1;
      cur.totalNet += s.est.net;
      cur.totalGross += s.est.gross;
      cur.hours += 1;
    } else {
      if (cur) shifts.push(cur);
      cur = {
        d: s.d, startHour: s.h, endHour: s.h + 1,
        id: s.id, hours: 1,
        totalNet: s.est.net, totalGross: s.est.gross,
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
  let weeklyNet = 0, weeklyGross = 0, weeklyHours = 0;

  const byDay = {};
  for (const s of shifts) {
    (byDay[s.d] = byDay[s.d] || []).push(s);
    weeklyNet += s.totalNet;
    weeklyGross += s.totalGross;
    weeklyHours += s.hours;
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
      const shift = document.createElement("div");
      shift.className = "shift";
      shift.innerHTML = `
        <span class="dot" style="background:${p.color}"></span>
        <span class="time">${rangeLabel(s.startHour, s.endHour)}</span>
        <span class="plat">${p.name}</span>
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

function renderTier() {
  const isPro = state.tier === "pro";
  document.body.classList.toggle("pro", isPro);
  document.querySelectorAll(".pro-lock").forEach(el => {
    el.style.display = isPro ? "none" : "flex";
  });
  document.getElementById("tier-label").textContent = isPro ? "Pro Subscriber" : "Free Preview";
  document.getElementById("tier-toggle").textContent = isPro ? "Switch to Free" : "Upgrade to Pro (Demo)";
}

function renderAll() {
  const grid = buildWeeklyHeatmap();
  const chosen = recommendSchedule(grid, state.hoursPerWeek);
  const shifts = groupShifts(chosen);
  renderHeatmap(grid);
  renderSchedule(shifts);
  renderZones();
  renderNowRecommendation();
  renderTier();
}

function wireControls() {
  document.getElementById("market").addEventListener("change", e => {
    state.market = e.target.value; renderAll();
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
  document.getElementById("vehicle").addEventListener("change", e => {
    state.vehicle = e.target.value; renderAll();
  });
  document.getElementById("tier-toggle").addEventListener("click", () => {
    state.tier = state.tier === "pro" ? "free" : "pro"; renderAll();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderMarketOptions();
  renderPlatformChoices();
  wireControls();
  document.getElementById("hours-val").textContent = state.hoursPerWeek + " hrs/week";
  renderAll();
});
