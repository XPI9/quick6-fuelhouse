// ============================================================================
//  NUTRITION TARGETS  (computed in CODE — the AI never invents these numbers)
//  Mifflin-St Jeor BMR -> athlete TDEE -> goal + position adjusted calories,
//  with HARD SAFETY FLOORS so no athlete ever gets a dangerous target.
//  The AI receives these numbers and builds the meal plan to hit them.
// ============================================================================

// Training-load multipliers, framed for athletes (higher than desk-job scales).
export const ACTIVITY = {
  light:    { factor: 1.5,  label: 'Off-season / lifting 2–3x a week' },
  moderate: { factor: 1.65, label: 'In training — 4–5 sessions a week' },
  high:     { factor: 1.8,  label: 'Daily practice + lifting' },
  camp:     { factor: 2.0,  label: 'Camp / two-a-days / peak volume' },
};

// Goal calorie multipliers (applied to TDEE), plus display labels.
export const GOALS = {
  gain:    { mult: 1.13, label: 'Build mass' },
  maintain:{ mult: 1.0,  label: 'Maintain & perform' },
  perform: { mult: 1.03, label: 'Fuel for speed / power' },
  lean:    { mult: 0.82, label: 'Lean out (keep power)' },
  lose:    { mult: 0.78, label: 'Lose weight (stay strong)' },
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
  // Cap a bulk at ~18% over maintenance (lean mass, not just fat)
  if (goal === 'gain' && calories > tdee * 1.18) { calories = tdee * 1.18; notes.push('Surplus capped at 18% to favor lean mass.'); }
  calories = round(calories / 10) * 10;

  // 5) Macros — protein by position; carbs prioritized for performance
  const protein_g = round(clamp(weightKg * ((profile && profile.proteinPerKg) || 2.0), 60, 300));
  let fat_g = round((calories * 0.27) / 9);
  let carbs_g = round((calories - protein_g * 4 - fat_g * 9) / 4);
  // Keep carbs adequate to train on (>= ~3 g/kg, cutters >= 2 g/kg); pull from fat if needed
  const carbFloor = round(weightKg * (CUT_GOALS.has(goal) ? 2.5 : 3.5));
  if (carbs_g < carbFloor) {
    carbs_g = carbFloor;
    fat_g = Math.max(round(weightKg * 0.5), round((calories - protein_g * 4 - carbs_g * 4) / 9));
    notes.push('Carbs kept high enough to fuel training.');
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
