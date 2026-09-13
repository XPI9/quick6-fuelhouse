// ============================================================================
//  Quick6 FuelHouse — server
//    GET  /api/positions  -> sports + positions/events for the form
//    POST /api/plan       -> {athlete} -> computed targets + AI meal/training plan
//    GET  /api/health
// ============================================================================

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sports, profileFor, METRICS, metricsFor } from './lib/positions.js';
import { computeTargets, ACTIVITY, GOALS } from './lib/nutrition.js';
import { generatePlan } from './lib/anthropic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

const KEY_OK = !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('REPLACE');

// --- simple per-IP hourly rate limit (no accounts yet) ---
const _hits = new Map();
function underLimit(ip, max) {
  const now = Date.now(), WIN = 3600000;
  const arr = (_hits.get(ip) || []).filter((t) => now - t < WIN);
  if (arr.length >= max) return false;
  arr.push(now); _hits.set(ip, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of _hits) { const f = v.filter((t) => now - t < 3600000); if (f.length) _hits.set(k, f); else _hits.delete(k); } }, 1800000).unref();

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

app.get('/api/health', (_req, res) => res.json({ ok: true, anthropicKey: KEY_OK, model: process.env.FUEL_MODEL || 'claude-sonnet-5' }));

app.get('/api/positions', (_req, res) => res.json({
  sports: sports(),
  metrics: METRICS,
  activity: Object.entries(ACTIVITY).map(([key, v]) => ({ key, label: v.label })),
  goals: Object.entries(GOALS).map(([key, v]) => ({ key, label: v.label })),
}));

app.post('/api/plan', async (req, res) => {
  if (!KEY_OK) return res.status(400).json({ error: 'no_api_key', message: 'Add your ANTHROPIC_API_KEY to .env and restart.' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').toString().split(',')[0].trim();
  if (!underLimit(ip, Number(process.env.FUEL_LIMIT || 30))) return res.status(429).json({ error: 'rate', message: 'Hit the hourly limit — give it a few minutes.' });

  const b = req.body || {};
  const age = num(b.age), heightCm = num(b.heightCm), weightKg = num(b.weightKg);
  const sex = b.sex === 'female' ? 'female' : 'male';
  if (!(age >= 10 && age <= 60)) return res.status(400).json({ error: 'bad_input', message: 'Enter a valid age.' });
  if (!(heightCm >= 120 && heightCm <= 230)) return res.status(400).json({ error: 'bad_input', message: 'Enter a valid height.' });
  if (!(weightKg >= 30 && weightKg <= 230)) return res.status(400).json({ error: 'bad_input', message: 'Enter a valid weight.' });

  const sport = b.sport === 'track' ? 'track' : 'football';
  const profile = profileFor(sport, b.position);
  const goal = GOALS[b.goal] ? b.goal : profile.goalDefault;
  const activity = ACTIVITY[b.activity] ? b.activity : 'high';

  // Performance test numbers (optional) — label them so the AI can target weak spots.
  const rawMetrics = (b.metrics && typeof b.metrics === 'object') ? b.metrics : {};
  const metricDefs = metricsFor(sport);
  const metricsText = metricDefs
    .filter((m) => rawMetrics[m.key] != null && String(rawMetrics[m.key]).trim() !== '')
    .map((m) => `${m.label}: ${String(rawMetrics[m.key]).slice(0, 20)}${m.unit ? ' ' + m.unit : ''}`)
    .join(', ');

  const athlete = {
    name: (b.name || '').toString().slice(0, 80),
    age, sex, sport, diningHall: !!b.diningHall,
    restrictions: (b.restrictions || '').toString().slice(0, 300),
    notes: (b.notes || '').toString().slice(0, 300),
    metricsText,
  };

  try {
    const targets = computeTargets({ sex, age, heightCm, weightKg, activity, goal, profile });
    const plan = await generatePlan({ athlete, profile, targets });
    res.json({
      athlete: { ...athlete, positionLabel: profile.label },
      profile: { label: profile.label, focus: profile.focus, group: profile.group, groupSummary: profile.groupSummary },
      targets, plan,
    });
  } catch (e) {
    console.error('[plan]', e);
    res.status(500).json({ error: 'plan_failed', message: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => {
  console.log(`\n  Quick6 FuelHouse  →  http://localhost:${PORT}`);
  console.log(`  Claude key: ${KEY_OK ? 'loaded ✓' : 'MISSING ✗ (edit .env)'}`);
  console.log(`  Model: ${process.env.FUEL_MODEL || 'claude-sonnet-5'}\n`);
});
