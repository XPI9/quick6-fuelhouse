// ============================================================================
//  NUTRITION TARGETS  (computed in CODE — the AI never invents these numbers)
//  Mifflin-St Jeor BMR -> athlete TDEE -> goal + position adjusted calories,
//  with HARD SAFETY FLOORS so no athlete ever gets a dangerous target.
//  The AI receives these numbers and builds the meal plan to hit them.
// ============================================================================

// Training-load multipliers, framed for athletes (higher than desk-job scales).
export const ACTIVITY = {
  light:    { factor: 1.45, label: 'Off-season / lifting 2–3x a week' },
  moderate: { factor: 1.55, label: 'In training — 4–5 sessions a week' },
  high:     { factor: 1.7,  label: 'Daily practice + lifting' },
  camp:     { factor: 1.85, label: 'Camp / two-a-days / peak volume' },
};

// Goal calorie multipliers (applied to TDEE), plus display labels.
// Kept moderate on purpose — balanced, mainstream guidance (no aggressive bulking/cutting).
export const GOALS = {
  gain:    { mult: 1.08, label: 'Build mass' },
  maintain:{ mult: 1.0,  label: 'Maintain & perform' },
  perform: { mult: 1.02, label: 'Fuel for speed / power' },
  lean:    { mult: 0.85, label: 'Lean out (keep power)' },
  lose:    { mult: 0.82, label: 'Lose weight (stay strong)' },
};
// Goals that run a calorie deficit — share the same safety caps + carb floor.
const CUT_GOALS = new Set(['lean', 'lose']);

const round = (n) => Math.round(n);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function cmFrom(ft, inches) { return (Number(ft || 0) * 12 + Number(inches || 0)) * 2.54; }
export function kgFrom(lb) { return Number(lb || 0) / 2.2046226218; }
export function lbFrom(kg) { return kg * 2.2046226218; }

/**
 * @param {{sex:'male'|'female', age:number, heightCm:number, weightKg:number,
 *          activity:keyof typeof ACTIVITY, goal:keyof typeof GOALS, profile:object}} input
 */
export function computeTargets({ sex, age, heightCm, weightKg, activity, goal, profile }) {
  const A = ACTIVITY[activity] || ACTIVITY.high;
  const G = GOALS[goal] || GOALS.maintain;
  const calBias = (profile && profile.calBias) || 1.0;

  // 1) Mifflin-St Jeor BMR
  const s = sex === 'female' ? -161 : 5;
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + s;

  // 2) Athlete maintenance
  const tdee = bmr * A.factor;

  // 3) Goal + position adjusted target
  let calories = tdee * G.mult * calBias;

  // 4) SAFETY GUARDRAILS
  const notes = [];
  // Never below an athlete floor
  const floor = sex === 'female' ? 1600 : 1900;
  if (calories < floor) { calories = floor; notes.push(`Held at a safe athlete floor of ${floor} kcal.`); }
  // Cap a cut at ~20% below maintenance (no crash diets on young athletes)
  if (CUT_GOALS.has(goal) && calories < tdee * 0.80) { calories = tdee * 0.80; notes.push('Deficit capped at 20% to protect muscle and performance.'); }
  // Cap a bulk at ~12% over maintenance (steady, lean gain — not aggressive bulking)
  if (goal === 'gain' && calories > tdee * 1.12) { calories = tdee * 1.12; notes.push('Surplus capped at 12% for steady, lean gain.'); }
  calories = round(calories / 10) * 10;

  // 5) Macros — a balanced plate (moderate carbs, ~30% fat), not carb-loading.
  const protein_g = round(clamp(weightKg * ((profile && profile.proteinPerKg) || 1.8), 60, 260));
  let fat_g = round((calories * 0.30) / 9);
  let carbs_g = round((calories - protein_g * 4 - fat_g * 9) / 4);
  // Keep carbs in a sensible range for a young athlete — a floor to train on, a ceiling so it isn't carb-heavy.
  const carbFloor = round(weightKg * (CUT_GOALS.has(goal) ? 2.0 : 2.5));
  const carbCeil = round(weightKg * 5.0);
  if (carbs_g < carbFloor) {
    carbs_g = carbFloor;
    fat_g = Math.max(round(weightKg * 0.6), round((calories - protein_g * 4 - carbs_g * 4) / 9));
    notes.push('Balanced so carbs stay in a healthy range.');
  } else if (carbs_g > carbCeil) {
    carbs_g = carbCeil;
    fat_g = round((calories - protein_g * 4 - carbs_g * 4) / 9);
    notes.push('Carbs kept moderate — a balanced plate, not carb-loading.');
  }

  return {
    bmr: round(bmr),
    tdee: round(tdee),
    calories,
    protein_g,
    carbs_g,
    fat_g,
    activityFactor: A.factor,
    activityLabel: A.label,
    goalLabel: G.label,
    proteinPerKg: (profile && profile.proteinPerKg) || 2.0,
    weightLb: round(lbFrom(weightKg)),
    notes,
  };
}
