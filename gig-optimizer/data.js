// Market intelligence model for gig economy optimization.
//
// Earnings estimates are computed from a transparent multi-factor model
// rather than scraped from carrier APIs (which are not publicly available
// to drivers). Inputs: hour-of-week demand curves derived from public
// research on rideshare/delivery patterns, regional cost-per-mile baselines,
// platform commission structures, weather, and local events.

const PLATFORMS = {
  uber: {
    name: "Uber",
    type: "rideshare",
    color: "#000000",
    baselineHourly: 22.50,
    commissionRate: 0.25,
    vehicleRequired: true,
    minRating: 4.6,
    surgeCeiling: 3.5,
  },
  lyft: {
    name: "Lyft",
    type: "rideshare",
    color: "#FF00BF",
    baselineHourly: 21.00,
    commissionRate: 0.25,
    vehicleRequired: true,
    minRating: 4.6,
    surgeCeiling: 3.0,
  },
  doordash: {
    name: "DoorDash",
    type: "food-delivery",
    color: "#EB1700",
    baselineHourly: 19.50,
    commissionRate: 0.0,
    vehicleRequired: true,
    minRating: 4.2,
    surgeCeiling: 2.5,
  },
  ubereats: {
    name: "Uber Eats",
    type: "food-delivery",
    color: "#06C167",
    baselineHourly: 18.75,
    commissionRate: 0.0,
    vehicleRequired: true,
    minRating: 4.5,
    surgeCeiling: 2.2,
  },
  grubhub: {
    name: "Grubhub",
    type: "food-delivery",
    color: "#F63440",
    baselineHourly: 17.50,
    commissionRate: 0.0,
    vehicleRequired: true,
    minRating: 4.5,
    surgeCeiling: 2.0,
  },
  instacart: {
    name: "Instacart",
    type: "grocery",
    color: "#43B02A",
    baselineHourly: 23.00,
    commissionRate: 0.0,
    vehicleRequired: true,
    minRating: 4.7,
    surgeCeiling: 1.8,
  },
  spark: {
    name: "Walmart Spark",
    type: "grocery",
    color: "#0071CE",
    baselineHourly: 20.50,
    commissionRate: 0.0,
    vehicleRequired: true,
    minRating: 4.5,
    surgeCeiling: 1.6,
  },
  amazonflex: {
    name: "Amazon Flex",
    type: "package",
    color: "#FF9900",
    baselineHourly: 24.00,
    commissionRate: 0.0,
    vehicleRequired: true,
    minRating: null,
    surgeCeiling: 1.4,
  },
};

// Demand multiplier for each hour 0-23, by day of week (0=Sun).
// Curves derived from published rideshare/delivery research showing
// commute peaks (rideshare), meal peaks (delivery), and weekend nightlife.
const DEMAND_CURVES = {
  uber: {
    weekday: [0.4,0.3,0.2,0.2,0.3,0.7,1.4,1.9,1.6,1.0,0.8,0.9,1.1,1.0,0.9,1.0,1.3,1.8,1.5,1.2,1.1,1.3,1.2,0.8],
    friday:  [0.5,0.3,0.2,0.2,0.3,0.7,1.4,1.9,1.6,1.0,0.8,0.9,1.1,1.0,0.9,1.0,1.4,2.0,1.9,1.8,2.1,2.4,2.6,2.2],
    saturday:[1.8,1.5,1.0,0.5,0.3,0.3,0.4,0.6,0.8,1.0,1.1,1.2,1.3,1.3,1.2,1.2,1.4,1.7,1.9,2.0,2.3,2.6,2.8,2.5],
    sunday:  [2.1,1.6,1.0,0.5,0.3,0.3,0.4,0.5,0.7,0.9,1.2,1.4,1.3,1.1,0.9,0.9,1.0,1.2,1.1,1.0,0.9,0.9,0.8,0.6],
  },
  lyft: {
    weekday: [0.4,0.3,0.2,0.2,0.3,0.6,1.3,1.8,1.5,1.0,0.8,0.9,1.0,0.9,0.8,0.9,1.2,1.7,1.4,1.1,1.0,1.2,1.1,0.8],
    friday:  [0.5,0.3,0.2,0.2,0.3,0.6,1.3,1.8,1.5,1.0,0.8,0.9,1.0,0.9,0.8,1.0,1.3,1.8,1.8,1.7,2.0,2.3,2.5,2.1],
    saturday:[1.7,1.4,0.9,0.5,0.3,0.3,0.4,0.5,0.7,0.9,1.0,1.1,1.2,1.2,1.1,1.1,1.3,1.6,1.8,1.9,2.2,2.5,2.7,2.4],
    sunday:  [2.0,1.5,0.9,0.5,0.3,0.3,0.4,0.5,0.6,0.8,1.1,1.3,1.2,1.0,0.8,0.8,0.9,1.1,1.0,0.9,0.8,0.8,0.7,0.5],
  },
  doordash: {
    weekday: [0.2,0.1,0.1,0.1,0.1,0.2,0.4,0.6,0.5,0.4,0.6,1.6,2.0,1.4,0.7,0.5,0.6,1.4,2.2,1.9,1.3,0.9,0.6,0.3],
    friday:  [0.2,0.1,0.1,0.1,0.1,0.2,0.4,0.6,0.5,0.4,0.6,1.6,2.0,1.4,0.7,0.6,0.8,1.7,2.5,2.4,2.0,1.5,1.0,0.5],
    saturday:[0.4,0.2,0.1,0.1,0.1,0.1,0.2,0.3,0.5,0.7,1.0,1.7,2.1,1.7,1.1,0.9,1.1,1.8,2.6,2.5,2.1,1.6,1.1,0.6],
    sunday:  [0.4,0.2,0.1,0.1,0.1,0.1,0.2,0.3,0.4,0.6,1.0,1.8,2.2,1.6,0.9,0.7,0.9,1.6,2.3,1.8,1.2,0.8,0.5,0.3],
  },
  ubereats: {
    weekday: [0.2,0.1,0.1,0.1,0.1,0.2,0.3,0.5,0.4,0.3,0.5,1.5,1.9,1.3,0.6,0.4,0.5,1.3,2.0,1.7,1.1,0.7,0.5,0.3],
    friday:  [0.2,0.1,0.1,0.1,0.1,0.2,0.3,0.5,0.4,0.3,0.5,1.5,1.9,1.3,0.6,0.5,0.7,1.5,2.3,2.2,1.8,1.3,0.8,0.4],
    saturday:[0.3,0.2,0.1,0.1,0.1,0.1,0.2,0.3,0.4,0.6,0.9,1.6,2.0,1.6,1.0,0.8,1.0,1.6,2.4,2.3,1.9,1.4,0.9,0.5],
    sunday:  [0.3,0.2,0.1,0.1,0.1,0.1,0.2,0.3,0.4,0.5,0.9,1.7,2.0,1.5,0.8,0.6,0.8,1.4,2.1,1.6,1.0,0.6,0.4,0.2],
  },
  grubhub: {
    weekday: [0.1,0.1,0.1,0.1,0.1,0.1,0.3,0.4,0.4,0.3,0.5,1.4,1.8,1.2,0.6,0.4,0.5,1.2,1.9,1.5,1.0,0.6,0.4,0.2],
    friday:  [0.1,0.1,0.1,0.1,0.1,0.1,0.3,0.4,0.4,0.3,0.5,1.4,1.8,1.2,0.6,0.5,0.7,1.4,2.1,2.0,1.6,1.1,0.7,0.3],
    saturday:[0.3,0.1,0.1,0.1,0.1,0.1,0.2,0.3,0.4,0.5,0.8,1.5,1.9,1.5,0.9,0.7,0.9,1.5,2.2,2.1,1.7,1.2,0.8,0.4],
    sunday:  [0.3,0.1,0.1,0.1,0.1,0.1,0.2,0.3,0.3,0.4,0.8,1.6,1.9,1.4,0.7,0.5,0.7,1.3,1.9,1.4,0.9,0.5,0.3,0.2],
  },
  instacart: {
    weekday: [0.1,0.1,0.1,0.1,0.1,0.1,0.3,0.5,0.7,1.2,1.6,1.7,1.4,1.5,1.6,1.5,1.4,1.2,0.9,0.6,0.4,0.3,0.2,0.1],
    friday:  [0.1,0.1,0.1,0.1,0.1,0.1,0.3,0.5,0.7,1.3,1.8,1.9,1.5,1.6,1.7,1.6,1.5,1.3,1.0,0.7,0.4,0.3,0.2,0.1],
    saturday:[0.1,0.1,0.1,0.1,0.1,0.1,0.2,0.4,0.8,1.5,2.0,2.2,1.9,1.7,1.6,1.5,1.4,1.2,0.9,0.6,0.4,0.2,0.2,0.1],
    sunday:  [0.1,0.1,0.1,0.1,0.1,0.1,0.2,0.4,0.9,1.6,2.1,2.3,2.0,1.8,1.6,1.5,1.4,1.1,0.8,0.5,0.3,0.2,0.1,0.1],
  },
  spark: {
    weekday: [0.1,0.1,0.1,0.1,0.1,0.1,0.4,0.7,1.0,1.4,1.6,1.5,1.3,1.4,1.5,1.4,1.3,1.1,0.8,0.5,0.3,0.2,0.1,0.1],
    friday:  [0.1,0.1,0.1,0.1,0.1,0.1,0.4,0.7,1.0,1.5,1.8,1.7,1.4,1.5,1.6,1.5,1.4,1.2,0.9,0.6,0.3,0.2,0.1,0.1],
    saturday:[0.1,0.1,0.1,0.1,0.1,0.1,0.3,0.6,1.0,1.6,2.0,2.0,1.7,1.5,1.5,1.4,1.3,1.1,0.8,0.5,0.3,0.2,0.1,0.1],
    sunday:  [0.1,0.1,0.1,0.1,0.1,0.1,0.3,0.5,1.0,1.7,2.1,2.1,1.8,1.6,1.5,1.4,1.3,1.0,0.7,0.4,0.2,0.1,0.1,0.1],
  },
  amazonflex: {
    weekday: [0.6,0.4,0.3,0.3,0.6,1.2,1.5,1.4,1.3,1.2,1.2,1.1,1.0,1.0,1.1,1.2,1.4,1.5,1.4,1.0,0.7,0.6,0.5,0.5],
    friday:  [0.6,0.4,0.3,0.3,0.6,1.2,1.5,1.4,1.3,1.2,1.2,1.1,1.0,1.0,1.1,1.2,1.4,1.5,1.4,1.0,0.7,0.6,0.5,0.5],
    saturday:[0.7,0.5,0.3,0.3,0.6,1.0,1.4,1.5,1.5,1.4,1.3,1.2,1.1,1.1,1.2,1.3,1.4,1.4,1.2,0.9,0.6,0.5,0.4,0.4],
    sunday:  [0.5,0.3,0.2,0.2,0.4,0.7,1.0,1.2,1.3,1.4,1.4,1.3,1.2,1.1,1.1,1.1,1.1,1.0,0.9,0.7,0.5,0.4,0.3,0.3],
  },
};

// Markets with cost-of-living adjusted earnings multipliers and hot zones.
const MARKETS = {
  "nyc": {
    name: "New York City, NY",
    multiplier: 1.45,
    fuelCost: 3.85,
    timezone: "America/New_York",
    zones: [
      { name: "Midtown Manhattan", lat: 40.7549, lng: -73.9840, demand: { rideshare: 2.4, delivery: 2.0, grocery: 1.6 } },
      { name: "Financial District", lat: 40.7074, lng: -74.0113, demand: { rideshare: 1.9, delivery: 1.7, grocery: 1.3 } },
      { name: "Williamsburg, BK", lat: 40.7081, lng: -73.9571, demand: { rideshare: 1.7, delivery: 2.1, grocery: 1.5 } },
      { name: "LaGuardia Airport", lat: 40.7769, lng: -73.8740, demand: { rideshare: 2.6, delivery: 0.4, grocery: 0.2 } },
      { name: "JFK Airport", lat: 40.6413, lng: -73.7781, demand: { rideshare: 2.8, delivery: 0.3, grocery: 0.2 } },
      { name: "Upper East Side", lat: 40.7736, lng: -73.9566, demand: { rideshare: 1.5, delivery: 1.8, grocery: 2.0 } },
    ],
  },
  "la": {
    name: "Los Angeles, CA",
    multiplier: 1.30,
    fuelCost: 4.95,
    timezone: "America/Los_Angeles",
    zones: [
      { name: "Downtown LA", lat: 34.0407, lng: -118.2468, demand: { rideshare: 2.1, delivery: 1.8, grocery: 1.4 } },
      { name: "Hollywood", lat: 34.0928, lng: -118.3287, demand: { rideshare: 2.3, delivery: 1.9, grocery: 1.3 } },
      { name: "Santa Monica", lat: 34.0195, lng: -118.4912, demand: { rideshare: 1.9, delivery: 1.7, grocery: 1.6 } },
      { name: "LAX Airport", lat: 33.9416, lng: -118.4085, demand: { rideshare: 2.7, delivery: 0.3, grocery: 0.2 } },
      { name: "Beverly Hills", lat: 34.0736, lng: -118.4004, demand: { rideshare: 1.6, delivery: 1.7, grocery: 1.9 } },
      { name: "Venice", lat: 33.9850, lng: -118.4695, demand: { rideshare: 1.7, delivery: 1.8, grocery: 1.4 } },
    ],
  },
  "chi": {
    name: "Chicago, IL",
    multiplier: 1.10,
    fuelCost: 3.95,
    timezone: "America/Chicago",
    zones: [
      { name: "The Loop", lat: 41.8786, lng: -87.6251, demand: { rideshare: 2.2, delivery: 1.9, grocery: 1.4 } },
      { name: "River North", lat: 41.8924, lng: -87.6342, demand: { rideshare: 2.0, delivery: 2.1, grocery: 1.5 } },
      { name: "Wicker Park", lat: 41.9088, lng: -87.6796, demand: { rideshare: 1.6, delivery: 2.0, grocery: 1.6 } },
      { name: "O'Hare Airport", lat: 41.9742, lng: -87.9073, demand: { rideshare: 2.5, delivery: 0.3, grocery: 0.2 } },
      { name: "Lincoln Park", lat: 41.9214, lng: -87.6513, demand: { rideshare: 1.5, delivery: 1.8, grocery: 1.7 } },
    ],
  },
  "atx": {
    name: "Austin, TX",
    multiplier: 1.05,
    fuelCost: 3.25,
    timezone: "America/Chicago",
    zones: [
      { name: "Downtown / 6th St", lat: 30.2672, lng: -97.7431, demand: { rideshare: 2.4, delivery: 1.7, grocery: 1.2 } },
      { name: "South Congress", lat: 30.2486, lng: -97.7494, demand: { rideshare: 1.8, delivery: 1.8, grocery: 1.4 } },
      { name: "The Domain", lat: 30.4012, lng: -97.7256, demand: { rideshare: 1.6, delivery: 1.9, grocery: 1.6 } },
      { name: "AUS Airport", lat: 30.1975, lng: -97.6664, demand: { rideshare: 2.3, delivery: 0.3, grocery: 0.2 } },
      { name: "East Austin", lat: 30.2641, lng: -97.7167, demand: { rideshare: 1.7, delivery: 1.9, grocery: 1.5 } },
    ],
  },
  "atl": {
    name: "Atlanta, GA",
    multiplier: 1.00,
    fuelCost: 3.15,
    timezone: "America/New_York",
    zones: [
      { name: "Midtown", lat: 33.7838, lng: -84.3830, demand: { rideshare: 2.0, delivery: 1.8, grocery: 1.4 } },
      { name: "Buckhead", lat: 33.8480, lng: -84.3624, demand: { rideshare: 1.8, delivery: 1.7, grocery: 1.7 } },
      { name: "Hartsfield-Jackson", lat: 33.6407, lng: -84.4277, demand: { rideshare: 2.9, delivery: 0.3, grocery: 0.2 } },
      { name: "Old Fourth Ward", lat: 33.7600, lng: -84.3700, demand: { rideshare: 1.6, delivery: 2.0, grocery: 1.4 } },
      { name: "Decatur", lat: 33.7748, lng: -84.2963, demand: { rideshare: 1.4, delivery: 1.7, grocery: 1.5 } },
    ],
  },
  "den": {
    name: "Denver, CO",
    multiplier: 1.08,
    fuelCost: 3.45,
    timezone: "America/Denver",
    zones: [
      { name: "LoDo / Downtown", lat: 39.7525, lng: -104.9995, demand: { rideshare: 2.1, delivery: 1.8, grocery: 1.3 } },
      { name: "RiNo", lat: 39.7691, lng: -104.9817, demand: { rideshare: 1.7, delivery: 2.0, grocery: 1.4 } },
      { name: "Capitol Hill", lat: 39.7383, lng: -104.9785, demand: { rideshare: 1.6, delivery: 1.9, grocery: 1.5 } },
      { name: "DEN Airport", lat: 39.8561, lng: -104.6737, demand: { rideshare: 2.5, delivery: 0.2, grocery: 0.1 } },
      { name: "Cherry Creek", lat: 39.7180, lng: -104.9525, demand: { rideshare: 1.4, delivery: 1.6, grocery: 1.7 } },
    ],
  },
};

const WEATHER_MODIFIERS = {
  clear: { rideshare: 1.00, delivery: 1.00, grocery: 1.00, label: "Clear" },
  cloudy: { rideshare: 1.02, delivery: 1.05, grocery: 1.00, label: "Cloudy" },
  rain: { rideshare: 1.25, delivery: 1.40, grocery: 1.20, label: "Rain" },
  storm: { rideshare: 1.45, delivery: 1.70, grocery: 1.35, label: "Storm" },
  snow: { rideshare: 1.55, delivery: 1.50, grocery: 1.45, label: "Snow" },
  hot: { rideshare: 1.10, delivery: 1.20, grocery: 1.15, label: "Heatwave" },
};

const EVENT_BOOSTS = {
  concert: { rideshare: 1.6, delivery: 1.1, grocery: 0.9 },
  sports: { rideshare: 1.5, delivery: 1.3, grocery: 0.9 },
  convention: { rideshare: 1.4, delivery: 1.2, grocery: 1.0 },
  holiday: { rideshare: 1.3, delivery: 1.5, grocery: 1.4 },
  none: { rideshare: 1.0, delivery: 1.0, grocery: 1.0 },
};

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function curveForDay(platform, dayIndex) {
  const curves = DEMAND_CURVES[platform];
  if (dayIndex === 0) return curves.sunday;
  if (dayIndex === 5) return curves.friday;
  if (dayIndex === 6) return curves.saturday;
  return curves.weekday;
}

window.GIG_DATA = {
  PLATFORMS, MARKETS, WEATHER_MODIFIERS, EVENT_BOOSTS, DAYS, curveForDay,
};
