// Community data layer — the basis of Peakr's data flywheel.
//
// In production this would be an anonymized, server-side pool of driver-
// reported earnings: every logged session sharpens the demand model for
// everyone in that market. Here it is seeded with simulated community data
// (dense for the Nashville flagship market, lighter elsewhere) and, within a
// single browser, real logged sessions are merged in locally so the
// confidence count grows as you contribute. Cross-user pooling needs a
// backend; that is called out in the app footer.
//
// Per platform: `samples` = number of reported driver-sessions, `mult` =
// crowd-reported net earnings relative to the raw baseline model
// (1.0 = model is on target; <1 = model is optimistic vs. reality).
(function () {

const COMMUNITY = {
  nash: {
    drivers: 1840,
    byPlatform: {
      uber:       { samples: 5200, mult: 0.86 },
      lyft:       { samples: 3100, mult: 0.84 },
      doordash:   { samples: 4800, mult: 0.80 },
      ubereats:   { samples: 2600, mult: 0.78 },
      grubhub:    { samples: 1400, mult: 0.76 },
      instacart:  { samples: 2200, mult: 0.88 },
      spark:      { samples: 1900, mult: 0.83 },
      amazonflex: { samples: 1500, mult: 0.90 },
    },
  },
  nyc: {
    drivers: 320,
    byPlatform: {
      uber:     { samples: 720, mult: 0.83 },
      lyft:     { samples: 410, mult: 0.81 },
      doordash: { samples: 560, mult: 0.79 },
      ubereats: { samples: 300, mult: 0.77 },
    },
  },
  la: {
    drivers: 280,
    byPlatform: {
      uber:     { samples: 640, mult: 0.85 },
      doordash: { samples: 480, mult: 0.81 },
      ubereats: { samples: 260, mult: 0.79 },
    },
  },
  chi: { drivers: 120, byPlatform: { uber: { samples: 240, mult: 0.86 }, doordash: { samples: 210, mult: 0.82 } } },
  atx: { drivers: 90, byPlatform: { uber: { samples: 180, mult: 0.87 }, doordash: { samples: 150, mult: 0.83 } } },
  atl: { drivers: 110, byPlatform: { uber: { samples: 220, mult: 0.84 }, doordash: { samples: 190, mult: 0.80 } } },
  den: { drivers: 70, byPlatform: { uber: { samples: 130, mult: 0.88 }, doordash: { samples: 110, mult: 0.84 } } },
};

// Simulated driver sign-up bounties (referral monetization surface).
// In production these are affiliate/referral programs the platforms pay for.
const REFERRALS = {
  spark:      { amount: 250, blurb: "Walmart Spark new-driver bonus" },
  instacart:  { amount: 200, blurb: "Instacart shopper sign-up bonus" },
  uber:       { amount: 150, blurb: "Uber Driver guaranteed earnings offer" },
  doordash:   { amount: 175, blurb: "DoorDash Dasher sign-up bonus" },
  ubereats:   { amount: 120, blurb: "Uber Eats first-deliveries bonus" },
  lyft:       { amount: 130, blurb: "Lyft new-driver earnings guarantee" },
  amazonflex: { amount: 100, blurb: "Amazon Flex onboarding bonus" },
};

const DEFAULT_PLATFORM = { samples: 0, mult: 1.0 };

function communityFor(market, platformId) {
  const m = COMMUNITY[market];
  if (!m || !m.byPlatform[platformId]) return { ...DEFAULT_PLATFORM };
  return { ...m.byPlatform[platformId] };
}

function communityDrivers(market) {
  return COMMUNITY[market] ? COMMUNITY[market].drivers : 0;
}

function communityTotalSamples(market) {
  const m = COMMUNITY[market];
  if (!m) return 0;
  return Object.values(m.byPlatform).reduce((s, p) => s + p.samples, 0);
}

window.COMMUNITY = {
  communityFor, communityDrivers, communityTotalSamples, REFERRALS,
};
})();
