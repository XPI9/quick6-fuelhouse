// ============================================================================
//  BRAND  —  one codebase, multiple brands. Only the name + color change.
//  Selected by env FUEL_BRAND (default 'quick6').
//    quick6  -> Quick6 FuelHouse (Keith Ballard, red)      fuel.xpisolutions.com
//    xpi     -> XPI Athlete Fuel (XPI, amber, HS coaches)  athletefuel.xpisolutions.com
// ============================================================================

const BRANDS = {
  quick6: {
    key: 'quick6', name: 'Quick6 FuelHouse', short: 'FuelHouse',
    accent: '#FF4A2E',
    markMain: 'QUICK', markAccent: '6', markSub: 'FUELHOUSE',
    tagline: 'House of Speed',
    iconDir: '/icons', demos: '/demos.json',
    site: 'fuel.xpisolutions.com', contact: 'xpisolution@gmail.com',
    leadCapture: true, // accounts + login (no re-signup)
    trial: null,       // no trial lock for now (set { days, plans } to re-enable)
  },
  xpi: {
    key: 'xpi', name: 'XPI Athlete Fuel', short: 'Athlete Fuel',
    accent: '#F2A93B',
    markMain: 'XPI', markAccent: '·', markSub: 'ATHLETE FUEL',
    tagline: 'Athlete Performance',
    iconDir: '/icons-xpi', demos: '/demos.xpi.json',
    site: 'athletefuel.xpisolutions.com', contact: 'xpisolution@gmail.com',
    leadCapture: true, // XPI/HS-coach app: accounts + login (captures the coach as a lead)
    trial: null,       // no trial lock for now (set { days, plans } to re-enable)
  },
};

export const BRAND = BRANDS[(process.env.FUEL_BRAND || 'quick6').toLowerCase()] || BRANDS.quick6;
