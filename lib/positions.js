// ============================================================================
//  POSITION / EVENT INTELLIGENCE
//  Football and track athletes are fueled and built very differently by role.
//  Each profile drives: default goal, a calorie bias, protein target, carb
//  emphasis, and the performance focus the AI should build the plan around.
//  A lineman holds mass + power; a corner stays lean + explosive; a thrower
//  builds mass; a sprinter maximizes power-to-weight; a distance runner fuels
//  endurance. This is what makes the plan feel built for THAT kid.
// ============================================================================

// group -> human summary the AI uses as the athlete's build target
export const GROUPS = {
  big:      'Build and hold functional mass with real power; strength + short explosive work.',
  skill:    'Lean, fast, and explosive — protect power-to-weight; speed, agility, change-of-direction.',
  hybrid:   'Strong and rangy — a blend of mass and speed; power endurance.',
  thrower:  'Maximal power and mass; heavy strength + explosive throws.',
  sprint:   'Explosive power-to-weight; top-end speed and acceleration.',
  jump:     'Explosive, springy, lean; power-to-weight is everything.',
  middance: 'Power endurance — repeatable speed without carrying extra weight.',
  distance: 'Aerobic engine; fuel high training volume, stay light but not depleted.',
};

// goalDefault ties to nutrition.js goals: gain | lean | perform | maintain
function P(label, group, goalDefault, proteinPerKg, calBias, focus) {
  return { label, group, goalDefault, proteinPerKg, calBias, focus };
}

export const FOOTBALL = {
  ol: P('Offensive Line', 'big', 'gain', 2.0, 1.06, 'Anchor strength, hold mass through camp, drive-block power.'),
  dl: P('Defensive Line', 'big', 'gain', 2.0, 1.05, 'Explosive first step off the ball, hold mass, hand power.'),
  lb: P('Linebacker', 'hybrid', 'maintain', 2.1, 1.02, 'Sideline-to-sideline speed with pop; power endurance.'),
  te: P('Tight End', 'hybrid', 'maintain', 2.1, 1.02, 'Blocking mass plus route speed; strong and rangy.'),
  rb: P('Running Back', 'skill', 'maintain', 2.1, 1.0, 'Contact balance, breakaway speed, repeat-effort power.'),
  qb: P('Quarterback', 'skill', 'maintain', 1.9, 1.0, 'Lean, mobile, durable arm; steady energy across a game.'),
  wr: P('Wide Receiver', 'skill', 'lean', 2.1, 0.98, 'Top-end speed and separation; stay lean and springy.'),
  db: P('Defensive Back', 'skill', 'lean', 2.1, 0.98, 'Flip-and-run speed, change-of-direction, power-to-weight.'),
  ath: P('Athlete / Skill', 'skill', 'maintain', 2.0, 1.0, 'Overall speed, power, and durability.'),
  ks: P('Kicker / Punter', 'skill', 'maintain', 1.8, 1.0, 'Leg power and consistency; stable body weight.'),
};

export const TRACK = {
  sprint: P('Sprints (100/200)', 'sprint', 'perform', 2.0, 1.0, 'Acceleration and top-end speed; power-to-weight.'),
  quarter: P('400m', 'middance', 'perform', 2.0, 1.02, 'Speed endurance — hold top speed longer without added weight.'),
  hurdles: P('Hurdles', 'sprint', 'perform', 2.0, 1.0, 'Rhythm speed and explosive clearance; lean and springy.'),
  jumps: P('Jumps (LJ/TJ/HJ)', 'jump', 'perform', 2.0, 0.98, 'Explosive takeoff and elastic power; maximize power-to-weight.'),
  vault: P('Pole Vault', 'jump', 'perform', 2.0, 1.0, 'Explosive and springy with upper-body power.'),
  throws: P('Throws (Shot/Disc/Ham/Jav)', 'thrower', 'gain', 2.0, 1.06, 'Maximal strength and mass; explosive rotational power.'),
  middle: P('Middle Distance (800/1500)', 'middance', 'perform', 1.9, 1.05, 'Power endurance; fuel repeat speed without extra mass.'),
  distance: P('Distance (3k+/XC)', 'distance', 'maintain', 1.8, 1.08, 'Aerobic volume; fuel the mileage, stay light but not depleted.'),
};

export function sports() {
  return {
    football: Object.entries(FOOTBALL).map(([key, v]) => ({ key, label: v.label, goalDefault: v.goalDefault })),
    track: Object.entries(TRACK).map(([key, v]) => ({ key, label: v.label, goalDefault: v.goalDefault })),
  };
}

// Performance test fields by sport (combine metrics / track markers).
export const METRICS = {
  football: [
    { key: 'forty', label: '40-yd', unit: 'sec', ph: '4.65' },
    { key: 'vertical', label: 'Vertical', unit: 'in', ph: '32' },
    { key: 'broad', label: 'Broad', unit: 'in', ph: '112' },
    { key: 'shuttle', label: '20-yd Shuttle', unit: 'sec', ph: '4.30' },
    { key: 'threecone', label: '3-Cone', unit: 'sec', ph: '7.00' },
    { key: 'bench', label: 'Bench 225', unit: 'reps', ph: '18' },
  ],
  track: [
    { key: 'event', label: 'Event PR', unit: '', ph: '10.8 / 22-6' },
    { key: 'sixty', label: '60m', unit: 'sec', ph: '6.85' },
    { key: 'vertical', label: 'Vertical', unit: 'in', ph: '34' },
    { key: 'broad', label: 'Broad', unit: 'in', ph: '116' },
  ],
};
export function metricsFor(sport) { return METRICS[sport === 'track' ? 'track' : 'football']; }

export function profileFor(sport, positionKey) {
  const table = sport === 'track' ? TRACK : FOOTBALL;
  const p = table[positionKey] || (sport === 'track' ? TRACK.sprint : FOOTBALL.ath);
  return { ...p, groupSummary: GROUPS[p.group] || '' };
}
