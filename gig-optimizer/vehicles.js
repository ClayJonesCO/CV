// EPA combined city/highway MPG database for popular U.S. market vehicles.
// Source: fueleconomy.gov (EPA), most common gas trim per generation.
// Format: model -> array of [startYear, endYear, mpg].
// Hybrid and EV variants are listed as separate models; EV/PHEV values are MPGe.
//
// Wrapped in an IIFE so these top-level names stay out of the shared global
// lexical scope used by the other classic scripts.
(function () {
const VEHICLE_DB = {
  "Acura": {
    "ILX":              [[2013, 2022, 28]],
    "MDX":              [[2010, 2013, 18], [2014, 2020, 21], [2021, 2025, 22]],
    "RDX":              [[2010, 2018, 22], [2019, 2025, 24]],
    "TLX":              [[2015, 2020, 25], [2021, 2025, 24]],
    "Integra":          [[2023, 2025, 33]],
  },
  "Audi": {
    "A3":               [[2010, 2025, 28]],
    "A4":               [[2010, 2025, 27]],
    "A6":               [[2010, 2025, 25]],
    "Q3":               [[2015, 2025, 23]],
    "Q5":               [[2010, 2025, 23]],
    "Q7":               [[2010, 2025, 19]],
  },
  "BMW": {
    "2 Series":         [[2014, 2025, 27]],
    "3 Series":         [[2010, 2025, 28]],
    "5 Series":         [[2010, 2025, 26]],
    "X1":               [[2013, 2025, 26]],
    "X3":               [[2010, 2025, 25]],
    "X5":               [[2010, 2025, 22]],
    "i3":               [[2014, 2021, 113]],
  },
  "Buick": {
    "Enclave":          [[2010, 2025, 21]],
    "Encore":           [[2013, 2022, 28]],
    "Envision":         [[2016, 2025, 24]],
    "LaCrosse":         [[2010, 2019, 25]],
  },
  "Cadillac": {
    "ATS":              [[2013, 2019, 25]],
    "CT5":              [[2020, 2025, 25]],
    "Escalade":         [[2010, 2025, 16]],
    "XT4":              [[2019, 2025, 26]],
    "XT5":              [[2017, 2025, 22]],
  },
  "Chevrolet": {
    "Blazer":           [[2019, 2025, 23]],
    "Bolt EV":          [[2017, 2023, 118]],
    "Camaro":           [[2010, 2024, 22]],
    "Colorado":         [[2010, 2025, 20]],
    "Cruze":            [[2011, 2019, 31]],
    "Equinox":          [[2010, 2017, 26], [2018, 2025, 28]],
    "Impala":           [[2010, 2020, 22]],
    "Malibu":           [[2010, 2018, 29], [2019, 2024, 32]],
    "Silverado 1500":   [[2010, 2025, 17]],
    "Sonic":            [[2012, 2020, 31]],
    "Spark":            [[2013, 2022, 33]],
    "Suburban":         [[2010, 2025, 16]],
    "Tahoe":            [[2010, 2025, 17]],
    "Traverse":         [[2010, 2017, 18], [2018, 2025, 21]],
    "Trax":             [[2015, 2025, 28]],
    "Volt":             [[2011, 2019, 42]],
  },
  "Chrysler": {
    "300":              [[2010, 2023, 23]],
    "Pacifica":         [[2017, 2025, 22]],
    "Pacifica Hybrid":  [[2017, 2025, 82]],
    "Town & Country":   [[2010, 2016, 20]],
  },
  "Dodge": {
    "Challenger":       [[2010, 2023, 22]],
    "Charger":          [[2010, 2023, 22]],
    "Durango":          [[2010, 2025, 19]],
    "Grand Caravan":    [[2010, 2020, 20]],
    "Journey":          [[2010, 2020, 22]],
  },
  "Ford": {
    "Bronco":           [[2021, 2025, 19]],
    "Bronco Sport":     [[2021, 2025, 26]],
    "Edge":             [[2010, 2024, 23]],
    "Escape":           [[2010, 2019, 25], [2020, 2025, 28]],
    "Escape Hybrid":    [[2020, 2025, 41]],
    "Expedition":       [[2010, 2025, 19]],
    "Explorer":         [[2010, 2025, 21]],
    "F-150":            [[2010, 2025, 20]],
    "F-150 Lightning":  [[2022, 2025, 70]],
    "Fiesta":           [[2011, 2019, 33]],
    "Focus":            [[2010, 2018, 30]],
    "Fusion":           [[2010, 2020, 26]],
    "Fusion Hybrid":    [[2010, 2020, 42]],
    "Maverick":         [[2022, 2025, 26]],
    "Maverick Hybrid":  [[2022, 2025, 37]],
    "Mustang":          [[2010, 2025, 22]],
    "Mustang Mach-E":   [[2021, 2025, 98]],
    "Ranger":           [[2019, 2025, 22]],
    "Transit Connect":  [[2010, 2023, 24]],
  },
  "GMC": {
    "Acadia":           [[2010, 2025, 21]],
    "Canyon":           [[2015, 2025, 20]],
    "Sierra 1500":      [[2010, 2025, 17]],
    "Terrain":          [[2010, 2025, 26]],
    "Yukon":            [[2010, 2025, 17]],
  },
  "Honda": {
    "Accord":           [[2010, 2017, 30], [2018, 2025, 33]],
    "Accord Hybrid":    [[2014, 2025, 48]],
    "Civic":            [[2010, 2015, 32], [2016, 2021, 36], [2022, 2025, 36]],
    "Civic Hybrid":     [[2025, 2025, 49]],
    "CR-V":             [[2010, 2016, 26], [2017, 2025, 30]],
    "CR-V Hybrid":      [[2020, 2025, 38]],
    "Fit":              [[2010, 2020, 33]],
    "HR-V":             [[2016, 2025, 28]],
    "Insight":          [[2019, 2022, 52]],
    "Odyssey":          [[2010, 2025, 22]],
    "Passport":         [[2019, 2025, 21]],
    "Pilot":            [[2010, 2025, 22]],
    "Ridgeline":        [[2010, 2025, 21]],
  },
  "Hyundai": {
    "Accent":           [[2012, 2022, 33]],
    "Elantra":          [[2010, 2020, 33], [2021, 2025, 37]],
    "Elantra Hybrid":   [[2021, 2025, 54]],
    "Ioniq":            [[2017, 2022, 58]],
    "Ioniq 5":          [[2022, 2025, 114]],
    "Kona":             [[2018, 2025, 30]],
    "Kona Electric":    [[2019, 2025, 120]],
    "Palisade":         [[2020, 2025, 22]],
    "Santa Fe":         [[2010, 2025, 24]],
    "Sonata":           [[2010, 2025, 32]],
    "Sonata Hybrid":    [[2011, 2025, 47]],
    "Tucson":           [[2010, 2025, 26]],
    "Tucson Hybrid":    [[2022, 2025, 38]],
    "Venue":            [[2020, 2025, 32]],
  },
  "Jeep": {
    "Cherokee":         [[2014, 2023, 25]],
    "Compass":          [[2010, 2025, 26]],
    "Gladiator":        [[2020, 2025, 19]],
    "Grand Cherokee":   [[2010, 2025, 21]],
    "Patriot":          [[2010, 2017, 23]],
    "Renegade":         [[2015, 2023, 26]],
    "Wrangler":         [[2010, 2025, 19]],
    "Wrangler 4xe":     [[2021, 2025, 49]],
  },
  "Kia": {
    "EV6":              [[2022, 2025, 117]],
    "Forte":            [[2010, 2025, 34]],
    "K5":               [[2021, 2025, 32]],
    "Niro":             [[2017, 2025, 50]],
    "Niro EV":          [[2019, 2025, 113]],
    "Optima":           [[2010, 2020, 28]],
    "Rio":              [[2012, 2023, 36]],
    "Sorento":          [[2010, 2025, 24]],
    "Soul":             [[2010, 2025, 30]],
    "Sportage":         [[2010, 2025, 26]],
    "Telluride":        [[2020, 2025, 22]],
  },
  "Lexus": {
    "ES":               [[2010, 2025, 30]],
    "ES Hybrid":        [[2013, 2025, 44]],
    "IS":               [[2010, 2025, 25]],
    "NX":               [[2015, 2025, 28]],
    "RX":               [[2010, 2025, 22]],
    "RX Hybrid":        [[2010, 2025, 31]],
  },
  "Lincoln": {
    "Aviator":          [[2020, 2025, 21]],
    "Corsair":          [[2020, 2025, 25]],
    "MKZ":              [[2010, 2020, 26]],
    "Nautilus":         [[2019, 2025, 23]],
    "Navigator":        [[2010, 2025, 18]],
  },
  "Mazda": {
    "CX-3":             [[2016, 2021, 31]],
    "CX-30":            [[2020, 2025, 28]],
    "CX-5":             [[2013, 2025, 28]],
    "CX-9":             [[2010, 2023, 23]],
    "CX-50":            [[2023, 2025, 27]],
    "Mazda3":           [[2010, 2025, 33]],
    "Mazda6":           [[2010, 2021, 29]],
    "MX-5 Miata":       [[2010, 2025, 30]],
  },
  "Mercedes-Benz": {
    "C-Class":          [[2010, 2025, 26]],
    "E-Class":          [[2010, 2025, 25]],
    "GLA":              [[2015, 2025, 26]],
    "GLC":              [[2016, 2025, 24]],
    "GLE":              [[2010, 2025, 21]],
  },
  "Mitsubishi": {
    "Eclipse Cross":    [[2018, 2025, 26]],
    "Mirage":           [[2014, 2025, 39]],
    "Outlander":        [[2010, 2025, 27]],
    "Outlander Sport":  [[2011, 2024, 26]],
  },
  "Nissan": {
    "Altima":           [[2010, 2025, 32]],
    "Ariya":            [[2023, 2025, 99]],
    "Frontier":         [[2010, 2025, 20]],
    "Kicks":            [[2018, 2025, 33]],
    "Leaf":             [[2011, 2025, 108]],
    "Maxima":           [[2010, 2023, 24]],
    "Murano":           [[2010, 2024, 23]],
    "Pathfinder":       [[2010, 2025, 22]],
    "Rogue":            [[2010, 2025, 30]],
    "Sentra":           [[2010, 2025, 33]],
    "Titan":            [[2010, 2024, 17]],
    "Versa":            [[2012, 2025, 35]],
  },
  "Ram": {
    "1500":             [[2010, 2025, 20]],
    "2500":             [[2010, 2025, 15]],
    "ProMaster":        [[2014, 2025, 17]],
    "ProMaster City":   [[2015, 2022, 23]],
  },
  "Subaru": {
    "Ascent":           [[2019, 2025, 23]],
    "BRZ":              [[2013, 2025, 25]],
    "Crosstrek":        [[2013, 2025, 30]],
    "Forester":         [[2010, 2025, 29]],
    "Impreza":          [[2010, 2025, 31]],
    "Legacy":           [[2010, 2025, 30]],
    "Outback":          [[2010, 2025, 29]],
    "WRX":              [[2010, 2025, 22]],
  },
  "Tesla": {
    "Model 3":          [[2018, 2025, 132]],
    "Model S":          [[2012, 2025, 120]],
    "Model X":          [[2016, 2025, 102]],
    "Model Y":          [[2020, 2025, 122]],
  },
  "Toyota": {
    "4Runner":          [[2010, 2025, 17]],
    "Avalon":           [[2010, 2022, 25]],
    "Avalon Hybrid":    [[2013, 2022, 43]],
    "Camry":            [[2010, 2017, 28], [2018, 2024, 32], [2025, 2025, 51]],
    "Camry Hybrid":     [[2010, 2024, 46]],
    "C-HR":             [[2018, 2022, 29]],
    "Corolla":          [[2010, 2019, 32], [2020, 2025, 34]],
    "Corolla Hybrid":   [[2020, 2025, 52]],
    "Highlander":       [[2010, 2025, 24]],
    "Highlander Hybrid":[[2010, 2025, 36]],
    "Prius":            [[2010, 2022, 52], [2023, 2025, 57]],
    "Prius Prime":      [[2017, 2025, 78]],
    "RAV4":             [[2010, 2018, 27], [2019, 2025, 30]],
    "RAV4 Hybrid":      [[2016, 2025, 40]],
    "RAV4 Prime":       [[2021, 2025, 94]],
    "Sienna":           [[2010, 2020, 21], [2021, 2025, 36]],
    "Tacoma":           [[2010, 2025, 21]],
    "Tundra":           [[2010, 2025, 17]],
    "Venza":            [[2009, 2015, 22], [2021, 2024, 39]],
    "Yaris":            [[2010, 2020, 33]],
  },
  "Volkswagen": {
    "Atlas":            [[2018, 2025, 21]],
    "Atlas Cross Sport":[[2020, 2025, 22]],
    "Golf":             [[2010, 2021, 32]],
    "ID.4":             [[2021, 2025, 107]],
    "Jetta":            [[2010, 2025, 33]],
    "Passat":           [[2010, 2022, 29]],
    "Taos":             [[2022, 2025, 30]],
    "Tiguan":           [[2010, 2025, 24]],
  },
  "Volvo": {
    "S60":              [[2010, 2025, 27]],
    "V60":              [[2015, 2025, 27]],
    "XC40":             [[2019, 2025, 27]],
    "XC60":             [[2010, 2025, 24]],
    "XC90":             [[2010, 2025, 22]],
  },
};

function vehicleMakes() {
  return Object.keys(VEHICLE_DB).sort();
}

function vehicleModels(make) {
  if (!VEHICLE_DB[make]) return [];
  return Object.keys(VEHICLE_DB[make]).sort();
}

function vehicleYears(make, model) {
  const ranges = VEHICLE_DB[make]?.[model];
  if (!ranges) return [];
  let min = Infinity, max = -Infinity;
  for (const [s, e] of ranges) {
    if (s < min) min = s;
    if (e > max) max = e;
  }
  const years = [];
  for (let y = max; y >= min; y--) years.push(y);
  return years;
}

function lookupMPG(make, model, year) {
  const ranges = VEHICLE_DB[make]?.[model];
  if (!ranges) return null;
  for (const [s, e, mpg] of ranges) {
    if (year >= s && year <= e) return mpg;
  }
  return null;
}

window.VEHICLES = { VEHICLE_DB, vehicleMakes, vehicleModels, vehicleYears, lookupMPG };
})();
