// ============================================================================
//  Quick6 FuelHouse — server
//    GET  /api/positions  -> sports + positions/events for the form
//    POST /api/plan       -> {athlete} -> computed targets + AI meal/training plan
//    GET  /api/health
// ============================================================================

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './lib/brand.js';
import { sports, profileFor, METRICS, metricsFor, EQUIPMENT } from './lib/positions.js';
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
  equipment: EQUIPMENT,
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

  const equipment = ['gym', 'basic', 'home'].includes(b.equipment) ? b.equipment : 'gym';
  const injury = ['healthy', 'returning', 'injured'].includes(b.injury) ? b.injury : 'healthy';
  const injuryDesc = (b.injuryDesc || '').toString().slice(0, 200);

  const athlete = {
    name: (b.name || '').toString().slice(0, 80),
    age, sex, sport, diningHall: !!b.diningHall,
    restrictions: (b.restrictions || '').toString().slice(0, 300),
    notes: (b.notes || '').toString().slice(0, 300),
    metricsText, equipment, injury, injuryDesc,
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

// --- leads: capture a coach before the first plan (XPI brand only calls this) ---
const LEADS_FILE = path.join(__dirname, 'data', 'leads.jsonl');
const emailOk = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));

app.post('/api/lead', (req, res) => {
  const b = req.body || {};
  const rec = {
    ts: new Date().toISOString(),
    brand: (b.brand || BRAND.short || '').toString().slice(0, 40),
    name: (b.name || '').toString().slice(0, 120),
    school: (b.school || '').toString().slice(0, 160),
    email: (b.email || '').toString().slice(0, 160),
    phone: (b.phone || '').toString().slice(0, 40),
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
  };
  if (rec.name.length < 2 || !emailOk(rec.email)) return res.status(400).json({ error: 'bad_input' });
  try { fs.mkdirSync(path.dirname(LEADS_FILE), { recursive: true }); fs.appendFileSync(LEADS_FILE, JSON.stringify(rec) + '\n'); }
  catch (e) { console.error('[lead write]', e); }
  console.log('[lead]', rec.brand, '|', rec.name, '|', rec.school, '|', rec.email, '|', rec.phone);
  // Fire-and-forget forward to email/webhook (FormSubmit, Zapier, etc.) — never blocks the coach.
  const fwd = process.env.LEAD_FORWARD_URL;
  if (fwd && typeof fetch === 'function') {
    fetch(fwd, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rec, _subject: `New ${rec.brand} lead — ${rec.name}${rec.school ? ' (' + rec.school + ')' : ''}` }) }).catch(() => {});
  }
  res.json({ ok: true });
});

// Admin: pull the lead list (key-gated). GET /api/leads?key=YOUR_KEY  (&format=csv)
app.get('/api/leads', (req, res) => {
  const key = process.env.LEAD_ADMIN_KEY;
  if (!key || req.query.key !== key) return res.status(403).json({ error: 'forbidden' });
  let rows = [];
  try { rows = fs.readFileSync(LEADS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { rows = []; }
  if (req.query.format === 'csv') {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['ts', 'brand', 'name', 'school', 'email', 'phone', 'ip'];
    const csv = [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n');
    return res.type('text/csv').set('Content-Disposition', 'attachment; filename="leads.csv"').send(csv);
  }
  res.json({ count: rows.length, leads: rows.reverse() });
});

// --- brand: serve a per-brand index (no flash) + dynamic manifest ---
const INDEX_HTML = (() => {
  const B = BRAND;
  let h = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  return h
    .replace('<title>Quick6 FuelHouse</title>', `<title>${B.name}</title>`)
    .replace('<div class="q6">QUICK<span class="six">6</span><span class="sub">FUELHOUSE</span></div>',
             `<div class="q6">${B.markMain}<span class="six">${B.markAccent}</span><span class="sub">${B.markSub}</span></div>`)
    .replace('<div class="hos">House of Speed</div>', `<div class="hos">${B.tagline}</div>`)
    .replace('<div class="intro-mark">QUICK<span>6</span></div>', `<div class="intro-mark">${B.markMain}<span>${B.markAccent}</span></div>`)
    .replace('<div class="intro-word">FUELHOUSE</div>', `<div class="intro-word">${B.markSub}</div>`)
    .replace('<div class="intro-tag">House of Speed</div>', `<div class="intro-tag">${B.tagline}</div>`)
    .split('/icons/favicon-64.png').join(B.iconDir + '/favicon-64.png')
    .split('/icons/apple-touch-icon.png').join(B.iconDir + '/apple-touch-icon.png')
    .replace('content="FuelHouse"', `content="${B.short}"`)
    .replace('</head>', `<style>:root{--accent:${B.accent}}</style><script>window.__BRAND=${JSON.stringify({ name: B.name, short: B.short, accent: B.accent, tagline: B.tagline, demos: B.demos, leadCapture: !!B.leadCapture })}</script></head>`);
})();
function serveIndex(_req, res) { res.type('html').send(INDEX_HTML); }
app.get('/', serveIndex);
app.get('/index.html', serveIndex);
app.get('/pitch', (_req, res) => res.type('html').sendFile(path.join(__dirname, 'public', 'pitch.html')));
app.get('/manifest.webmanifest', (_req, res) => res.type('application/manifest+json').json({
  name: BRAND.name, short_name: BRAND.short,
  description: 'Performance nutrition + training plans for football & track athletes.',
  id: '/', start_url: '/?src=pwa', scope: '/', display: 'standalone',
  display_override: ['standalone', 'minimal-ui'], orientation: 'portrait-primary',
  background_color: '#0C0D10', theme_color: '#0C0D10',
  categories: ['sports', 'health', 'education'],
  icons: [
    { src: BRAND.iconDir + '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: BRAND.iconDir + '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: BRAND.iconDir + '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: BRAND.iconDir + '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => {
  console.log(`\n  ${BRAND.name}  (${BRAND.key})  →  http://localhost:${PORT}`);
  console.log(`  Claude key: ${KEY_OK ? 'loaded ✓' : 'MISSING ✗ (edit .env)'}`);
  console.log(`  Model: ${process.env.FUEL_MODEL || 'claude-sonnet-5'}\n`);
});
