// ============================================================================
//  AI LAYER (Claude) — builds the plan AROUND the code-computed targets.
//  The model never sets calorie/macro numbers; it fills them with real,
//  dining-hall-accessible food and position-specific performance training.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.FUEL_MODEL || 'claude-sonnet-5';

function extractJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object in model output');
  const end = text.lastIndexOf('}');
  const s = text.slice(start, end > start ? end + 1 : undefined);
  try { return JSON.parse(s); } catch (e) {
    try {
      let r = s.replace(/,\s*$/, '');
      const need = (o, c) => Math.max(0, (r.match(o) || []).length - (r.match(c) || []).length);
      r += ']'.repeat(need(/\[/g, /\]/g)) + '}'.repeat(need(/\{/g, /\}/g));
      return JSON.parse(r);
    } catch (_) { throw e; }
  }
}

const SYSTEM = `You are Quick6 FuelHouse — a performance nutrition and training assistant built for football and track & field athletes, many at HBCU programs that don't have a team dietitian.

ABSOLUTE RULES:
1. THE NUMBERS ARE FIXED. The daily calorie and macro targets are given to you — they were computed scientifically. Build the day's meals to ADD UP to those targets. NEVER invent, change, or contradict the targets. Per-meal calorie/protein figures are your best estimates and should sum close to the daily target.
2. WHOLE FOOD ONLY — NO SUPPLEMENTS. Recommend real, whole food and water. Do NOT recommend ANY supplements, vitamins, protein powders, creatine, pre-workout, or performance products — none, for any age. Keep guidance conservative and mainstream, consistent with reputable general medical-nutrition advice (balanced meals, whole foods, adequate hydration) — do NOT cite or name any organization. NO banned substances, NO extreme cuts, fasting, or dehydration. NEVER encourage rapid weight loss, skipping meals, or "cutting weight." If anything hints at disordered eating, steer to eating enough and suggest talking to a coach or doctor.
   BALANCED, NOT CARB-LOADED. Build a balanced plate — lean protein, whole-grain/starchy carbs in moderation, plenty of fruit and vegetables, healthy fats. Do NOT push high-carb intake or carbohydrate "loading"; keep carbohydrate moderate and balanced against protein, fat, and produce.
3. REAL LIFE ON CAMPUS. Assume the athlete eats in a college dining hall / cafeteria on a student budget. Meals must be buildable from cafeteria stations, a dorm microwave, or a cheap grocery run — not gourmet meal prep.
4. POSITION-SPECIFIC. Tailor the training and performance notes to the athlete's position/event focus provided.
5. NOT MEDICAL ADVICE. This is coaching guidance a trainer reviews, not medical or dietary treatment.
6. INJURY SAFETY. You are NOT a doctor, physical therapist, or athletic trainer, and this is NEVER a rehab or treatment plan.
   - If the athlete is CURRENTLY INJURED and NOT medically cleared: do NOT program training that loads or tests the body. Keep any activity to gentle general movement only, put recovery-supporting nutrition first (adequate protein, calories, whole foods, hydration, sleep — general guidance), and state plainly that they must be evaluated and cleared by a physician or physical therapist before training resumes.
   - If the athlete is RETURNING from injury (cleared, building back): make the training CONSERVATIVE and gradual — work around the affected area, avoid aggressively loading it, emphasize mobility, prehab, and technique over intensity, ramp slowly, and repeat that they must stay within what their doctor/PT cleared and stop and re-check if pain returns.
   - NEVER diagnose, never name a specific rehab protocol as treatment, never contradict a doctor. Always fill "injuryNote" with conservative guidance + the get-cleared-by-a-doctor reminder when an injury is present.
7. PROGRESSION. If PRIOR test numbers are given, compare the CURRENT numbers to the most recent prior test. In "progressionNote", tell the coach in plain, encouraging language what IMPROVED and what REGRESSED or STALLED since last time (name the specific metrics and the direction), then adapt THIS plan to it: double down on what's working, and shift training/fueling toward what isn't (e.g. speed improved but weight dropped too far → add calories; a weak metric stalled → bias training harder to it). Be honest but never discouraging — these are kids.
8. OUTPUT ONLY one JSON object in the exact schema. No prose, no markdown.`;

function schema() {
  return `Return JSON with exactly this shape:
{
  "headline": string,          // short, e.g. "Camp-mass fuel for a D-lineman"
  "summary": string,           // 2-3 sentences: the strategy for THIS athlete and goal
  "injuryNote": string,        // ONLY if an injury was reported: 1-3 sentences of CONSERVATIVE guidance (what to be careful with / work-around approach) + a clear "must be evaluated and cleared by a doctor or physical therapist" reminder. Otherwise "".
  "dayMeals": [ { "meal": string, "time": string, "items": [string], "approxCals": number, "approxProtein": number } ],
      // one full day: Breakfast, Lunch, Dinner, plus pre-training / post-training / snack as needed.
      // The approxCals across all meals should sum close to the DAILY CALORIE TARGET, and approxProtein close to the protein target.
  "diningHallTips": [ string ],  // 3-5 concrete ways to hit this in a cafeteria / on a budget (which stations, cheap high-protein picks, portions)
  "hydration": string,           // daily fluid target + around training and heat
  "gameDay": string,             // pre-game/pre-meet, during, and post-competition fueling
  "recovery": string,            // post-training refuel window, sleep, soreness
  "perfNotes": string,           // ONLY if performance test numbers were given: 1-2 sentences naming the biggest weakness and what to prioritize. Else "".
  "progressionNote": string,     // ONLY if PRIOR test numbers were given: 2-4 sentences comparing current vs last test — what improved, what regressed/stalled, and how this plan adapts. Else "".
  "training": { "focus": string, "week": [ { "day": string, "session": string } ] },
      // 3-5 training days matched to the position/event focus (speed, explosive power, change-of-direction, strength, injury prevention). If test numbers were given, bias the sessions toward the weak spot.
  "moves": [ string ],           // 5-12 SPECIFIC exercise names used in the training that a young athlete may need to see demonstrated (e.g. "Burpee", "Mountain climber", "Split-squat jump", "Bear crawl", "Plank"). Use clean, searchable names. Prefer the bodyweight/technical ones.
  "supplements": [],             // ALWAYS an empty array — never recommend supplements or vitamins.
  "watchFor": [ string ]         // 2-4 red flags for the COACH (e.g. losing weight too fast, low energy, not eating breakfast)
}`;
}

const EQUIP_NOTE = {
  gym: 'Full weight room available — barbell, dumbbell, and machine work are fine.',
  basic: 'ONLY dumbbells + resistance bands (plus bodyweight) — no barbells or machines. Build the strength/power work around dumbbells, bands, and bodyweight.',
  home: 'NO gym and NO weights — home / bodyweight ONLY. Build ALL the strength and power work from bodyweight and free movements: push-ups (and variations), squats, lunges, split squats, glute bridges, calf raises, planks and core, burpees, mountain climbers, plus sprints, hill/stair runs, and jumps/plyometrics. Do NOT prescribe any barbell, dumbbell, or machine lifts. Pull-ups only if a bar is likely available, and say "if you have a bar".',
};

export async function generatePlan({ athlete, profile, targets }) {
  const user = [
    `ATHLETE: ${athlete.name || 'Athlete'} — ${athlete.sport === 'track' ? 'Track & Field' : 'Football'}, ${profile.label}`,
    `Age ${athlete.age}, ${athlete.sex}, ${targets.weightLb} lb.`,
    `Build target: ${profile.groupSummary}`,
    `Position/event focus: ${profile.focus}`,
    `Goal: ${targets.goalLabel}. Training load: ${targets.activityLabel}.`,
    `Equipment: ${EQUIP_NOTE[athlete.equipment] || EQUIP_NOTE.gym}`,
    athlete.diningHall ? 'Eats mostly in the college DINING HALL on a student budget — keep every meal cafeteria-buildable and affordable.' : '',
    athlete.restrictions ? `Dietary restrictions / allergies: ${athlete.restrictions}. Respect these strictly.` : '',
    athlete.notes ? `Coach notes: ${athlete.notes}` : '',
    athlete.metricsText ? `Latest performance test numbers: ${athlete.metricsText}. Read these, name the biggest weakness, and steer the TRAINING toward improving it (speed, explosiveness, change-of-direction, or strength as the numbers indicate).` : '',
    athlete.historyText ? `PRIOR TEST HISTORY (oldest to newest) — compare the LATEST numbers above against the most recent prior test and fill "progressionNote":\n${athlete.historyText}` : '',
    athlete.injury === 'injured' ? `INJURY — CURRENTLY INJURED, NOT medically cleared${athlete.injuryDesc ? ' ('+athlete.injuryDesc+')' : ''}. Follow the INJURY SAFETY rule: no loading/testing training, recovery nutrition first, and require doctor/PT clearance before training. Fill injuryNote.` : '',
    athlete.injury === 'returning' ? `INJURY — RETURNING from injury, cleared and building back${athlete.injuryDesc ? ' ('+athlete.injuryDesc+')' : ''}. Follow the INJURY SAFETY rule: conservative, gradual training that works around the area, prehab/mobility emphasis, stay within doctor/PT clearance. Fill injuryNote.` : '',
    (Number(athlete.age) && Number(athlete.age) < 18) ? `THIS ATHLETE IS A MINOR (age ${athlete.age}). Whole food and water only — no supplements or vitamins of any kind. Keep it balanced and conservative.` : '',
    ``,
    `FIXED DAILY TARGETS (build the meals to hit these — do not change them):`,
    `  Calories: ${targets.calories} kcal`,
    `  Protein: ${targets.protein_g} g`,
    `  Carbs: ${targets.carbs_g} g`,
    `  Fat: ${targets.fat_g} g`,
    ``,
    schema(),
  ].filter(Boolean).join('\n');

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: Number(process.env.FUEL_MAX_TOKENS || 9000),
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  });
  const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  const d = extractJSON(text);
  d.dayMeals = Array.isArray(d.dayMeals) ? d.dayMeals : [];
  d.training = d.training && Array.isArray(d.training.week) ? d.training : { focus: profile.focus, week: [] };
  d.supplements = []; // never surface supplements/vitamins, whatever the model returns
  d.perfNotes = typeof d.perfNotes === 'string' ? d.perfNotes : '';
  d.progressionNote = typeof d.progressionNote === 'string' ? d.progressionNote : '';
  d.injuryNote = typeof d.injuryNote === 'string' ? d.injuryNote : '';
  d.moves = Array.isArray(d.moves) ? d.moves.filter((m) => typeof m === 'string').slice(0, 14) : [];
  // Guard against a truncated/empty generation — don't show the coach a broken plan.
  if (!d.dayMeals.length) throw new Error('The plan came back incomplete — tap Build again.');
  return d;
}

// ---- Game Week: a full week of fueling + recovery anchored to game/meet day ----
const GW_SYSTEM = `You are a nutrition assistant building a GAME-WEEK fueling and recovery timeline for a football or track athlete. WHOLE FOOD AND WATER ONLY — never recommend supplements, vitamins, protein powder, or sports supplements of any kind. Keep it balanced, conservative, and mainstream (whole foods, a balanced plate, good hydration) — do NOT push high-carb intake or carbohydrate "loading," and do NOT cite any organization. Real dining-hall/grocery food, budget-friendly. Coaching guidance a trainer reviews, NOT medical advice. Sensible practice only: recover early in the week, eat balanced familiar meals and hydrate well the 1–2 days before, a timed pre-game meal, water and light familiar food during, and a normal recovery meal after. Output ONLY one JSON object in the exact schema — no prose, no markdown.`;
function gwSchema() {
  return `Return JSON exactly:
{
  "week": [ { "day": string, "tag": string, "fuel": string } ],
      // EXACTLY 7 entries, one per weekday, in order. "day" = weekday name. "tag" = one short label
      // (e.g. "Recovery", "Balanced", "Train", "Pre-game", "Game day", "Rest"). "fuel" = 1-2 plain sentences
      // on what to eat / emphasize that day RELATIVE to game day (carbs, protein, hydration, sleep).
  "gameDayTimeline": [ { "time": string, "what": string } ],
      // 5-7 steps for game/meet day itself: e.g. "Wake / 3-4 hrs before", "1-2 hrs before",
      // "Pre-game / warmups", "During (sideline)", "Halftime", "Right after (recovery window)".
  "note": string   // one key reminder for the week (hydration or sleep), 1 sentence.
}`;
}
export async function generateGameWeek({ athlete, profile, targets, gameDay }) {
  const user = [
    `ATHLETE: ${athlete.name || 'Athlete'} — ${athlete.sport === 'track' ? 'Track & Field' : 'Football'}, ${profile.label}, ${targets.weightLb} lb.`,
    `Goal: ${targets.goalLabel}. Daily targets ~${targets.calories} kcal, ${targets.protein_g} g protein, ${targets.carbs_g} g carbs.`,
    `GAME/MEET DAY is ${gameDay}. Build the fueling + recovery plan for the FULL week anchored to it (recover early-week, balanced familiar meals + good hydration the 1-2 days before, a timed game-day meal, normal post-game recovery). Whole food and water only — no supplements. Keep carbohydrate moderate, not loaded.`,
    athlete.diningHall ? 'Eats mostly in the college dining hall on a budget — keep every meal cafeteria-buildable.' : '',
    athlete.injury === 'injured' ? 'INJURY: currently injured and NOT cleared — keep it recovery nutrition and gentle movement only, no loading, and note they must be cleared by a doctor before playing.' : '',
    athlete.injury === 'returning' ? 'INJURY: returning from injury (cleared) — keep the week conservative, recovery-forward, within their clearance.' : '',
    '',
    gwSchema(),
  ].filter(Boolean).join('\n');
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: Number(process.env.FUEL_GW_MAX_TOKENS || 4000),
    system: GW_SYSTEM,
    messages: [{ role: 'user', content: user }],
  });
  const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  const d = extractJSON(text);
  d.week = Array.isArray(d.week) ? d.week.slice(0, 7) : [];
  d.gameDayTimeline = Array.isArray(d.gameDayTimeline) ? d.gameDayTimeline : [];
  d.note = typeof d.note === 'string' ? d.note : '';
  d.gameDay = gameDay;
  return d;
}
