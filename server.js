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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRAND } from './lib/brand.js';
import { sports, profileFor, METRICS, metricsFor, EQUIPMENT } from './lib/positions.js';
import { computeTargets, ACTIVITY, GOALS } from './lib/nutrition.js';
import { generatePlan, generateGameWeek } from './lib/anthropic.js';

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

// --- trial + activation (XPI brand only; quick6 has trial:null and stays open) ---
const TRIAL = BRAND.trial ? {
  days: Number(process.env.TRIAL_DAYS || BRAND.trial.days || 3),
  plans: Number(process.env.TRIAL_PLANS || BRAND.trial.plans || 12),
} : null;
const ACTIVATION_CODES = new Set((process.env.FUEL_ACTIVATION_CODES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 160);

// Unified per-coach account store (auth + trial + roster), keyed by email.
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
let USERS = {};
try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}; } catch { USERS = {}; }
// One-time migration from the older coaches.json (trial/activation only).
try { const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'coaches.json'), 'utf8')); for (const [k, v] of Object.entries(old || {})) if (!USERS[k]) USERS[k] = v; } catch { /* none */ }
let _saveT = null;
function saveUsers() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => { try { fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true }); fs.writeFileSync(USERS_FILE, JSON.stringify(USERS)); } catch (e) { console.error('[users save]', e); } }, 200);
}

// Shared plan links (public, read-only) — token -> plan snapshot.
const SHARES_FILE = path.join(__dirname, 'data', 'shares.json');
let SHARES = {};
try { SHARES = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')) || {}; } catch { SHARES = {}; }
let _saveS = null;
function saveShares() {
  clearTimeout(_saveS);
  _saveS = setTimeout(() => { try { fs.mkdirSync(path.dirname(SHARES_FILE), { recursive: true }); fs.writeFileSync(SHARES_FILE, JSON.stringify(SHARES)); } catch (e) { console.error('[shares save]', e); } }, 200);
}

// --- lightweight auth: email + PIN (hashed), bearer token per device ---
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const publicUser = (u) => u && ({ email: u.email, name: u.name || '', school: u.school || '', phone: u.phone || '', photo: u.photo || '', activated: !!u.activated, plans: u.plans || 0 });
function addToken(u) { const t = newToken(); u.tokens = (u.tokens || []); u.tokens.push(t); if (u.tokens.length > 10) u.tokens = u.tokens.slice(-10); return t; }
function tokenOf(req) {
  const h = String(req.headers['authorization'] || '');
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return (req.body && req.body.token) || '';
}
function userFromToken(tok) {
  if (!tok) return null;
  for (const u of Object.values(USERS)) { if (u.token === tok) return u; if (Array.isArray(u.tokens) && u.tokens.includes(tok)) return u; }
  return null;
}
function requireUser(req, res) {
  const u = userFromToken(tokenOf(req));
  if (!u) { res.status(401).json({ error: 'auth', message: 'Please sign in again.' }); return null; }
  return u;
}

// POST /api/signup — create an account (email + PIN). Also logs the lead.
app.post('/api/signup', (req, res) => {
  const b = req.body || {};
  const email = normEmail(b.email);
  const pin = String(b.pin || '').trim();
  const name = (b.name || '').toString().slice(0, 120);
  const school = (b.school || '').toString().slice(0, 160);
  const phone = (b.phone || '').toString().slice(0, 40);
  if (name.length < 2 || !emailOk(email)) return res.status(400).json({ error: 'bad_input', message: 'Enter your name and a valid email.' });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'bad_pin', message: 'Pick a 4–8 digit PIN.' });
  const existing = USERS[email];
  if (existing && existing.pinHash) return res.status(409).json({ error: 'exists', message: 'You already have an account — log in with your PIN.' });
  const salt = crypto.randomBytes(12).toString('hex');
  const u = existing || {};
  Object.assign(u, {
    email, name, school, phone,
    pinSalt: salt, pinHash: hashPin(pin, salt),
    firstSeen: u.firstSeen || Date.now(), createdAt: u.createdAt || Date.now(),
    plans: u.plans || 0, activated: !!u.activated, roster: u.roster || [],
  });
  const token = addToken(u);
  USERS[email] = u; saveUsers();
  // keep the marketing lead log flowing
  try { fs.mkdirSync(path.dirname(LEADS_FILE), { recursive: true }); fs.appendFileSync(LEADS_FILE, JSON.stringify({ ts: new Date().toISOString(), brand: BRAND.short, name, school, email, phone, via: 'signup' }) + '\n'); } catch {}
  const fwd = process.env.LEAD_FORWARD_URL;
  if (fwd && typeof fetch === 'function') fetch(fwd, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, school, email, phone, _subject: `New ${BRAND.short} signup — ${name}${school ? ' (' + school + ')' : ''}` }) }).catch(() => {});
  console.log('[signup]', email, '|', name, '|', school);
  res.json({ ok: true, token, coach: publicUser(u) });
});

// Brute-force guard for login: lock a given email+IP after too many wrong PINs.
const _loginFails = new Map();
function loginKey(req, email) { const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').toString().split(',')[0].trim(); return ip + '|' + email; }
function loginLocked(key) { const e = _loginFails.get(key); if (!e) return false; if (Date.now() > e.until) { _loginFails.delete(key); return false; } return e.count >= 6; }
function noteLoginFail(key) { const e = _loginFails.get(key) || { count: 0, until: 0 }; e.count += 1; e.until = Date.now() + 15 * 60000; _loginFails.set(key, e); }
setInterval(() => { const now = Date.now(); for (const [k, v] of _loginFails) if (now > v.until) _loginFails.delete(k); }, 20 * 60000).unref();

// POST /api/login — returning coach (email + PIN) -> a fresh token.
app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const email = normEmail(b.email);
  const pin = String(b.pin || '').trim();
  const key = loginKey(req, email);
  if (loginLocked(key)) return res.status(429).json({ error: 'locked', message: 'Too many wrong tries — wait 15 minutes and try again.' });
  const u = USERS[email];
  if (!u || !u.pinHash) { noteLoginFail(key); return res.status(404).json({ error: 'no_account', message: 'No account for that email — sign up first.' }); }
  if (hashPin(pin, u.pinSalt) !== u.pinHash) { noteLoginFail(key); return res.status(401).json({ error: 'bad_login', message: 'Wrong PIN. Try again.' }); }
  _loginFails.delete(key);
  const token = addToken(u); saveUsers();
  res.json({ ok: true, token, coach: publicUser(u) });
});

// GET /api/me — who am I (used to restore a session on load).
app.get('/api/me', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  res.json({ ok: true, coach: publicUser(u) });
});

// POST /api/admin/wipe — owner erases ALL coach data for this brand (gated by LEAD_ADMIN_KEY).
// Clears accounts, share links, and the signup log. For clearing test data before real coaches.
app.post('/api/admin/wipe', (req, res) => {
  const key = process.env.LEAD_ADMIN_KEY;
  const b = req.body || {};
  if (!key || b.key !== key) return res.status(403).json({ error: 'forbidden', message: 'Wrong admin key.' });
  const n = Object.keys(USERS).length;
  USERS = {}; SHARES = {};
  saveUsers(); saveShares();
  try { fs.writeFileSync(LEADS_FILE, ''); } catch (e) {}
  console.log('[wipe]', BRAND.key, 'erased', n, 'accounts');
  res.json({ ok: true, message: `Erased ${n} account(s), all share links, and the signup log for ${BRAND.name}. Clean slate.` });
});

// POST /api/admin/reset-pin — owner resets any coach's PIN (gated by LEAD_ADMIN_KEY).
app.post('/api/admin/reset-pin', (req, res) => {
  const key = process.env.LEAD_ADMIN_KEY;
  const b = req.body || {};
  if (!key || b.key !== key) return res.status(403).json({ error: 'forbidden', message: 'Wrong admin key.' });
  const email = normEmail(b.email);
  const pin = String(b.pin || '').trim();
  const u = USERS[email];
  if (!u) return res.status(404).json({ error: 'no_account', message: 'No account found for ' + email });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'bad_pin', message: 'PIN must be 4–8 digits.' });
  const salt = crypto.randomBytes(12).toString('hex');
  u.pinSalt = salt; u.pinHash = hashPin(pin, salt); u.tokens = []; u.token = undefined;
  saveUsers();
  console.log('[reset-pin]', email);
  res.json({ ok: true, message: 'PIN reset for ' + email + ' — they can log in now.' });
});

// POST /api/profile — update the coach's own name / school / photo.
app.post('/api/profile', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim().length >= 2) u.name = b.name.trim().slice(0, 120);
  if (typeof b.school === 'string') u.school = b.school.slice(0, 160);
  if (typeof b.photo === 'string') { if (b.photo === '') u.photo = ''; else if (/^data:image\//.test(b.photo) && b.photo.length < 300000) u.photo = b.photo; }
  saveUsers();
  res.json({ ok: true, coach: publicUser(u) });
});

// --- cloud roster: each coach's athletes live on their account (cross-device) ---
app.get('/api/roster', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  res.json({ ok: true, roster: u.roster || [] });
});
app.post('/api/athlete', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const a = req.body && req.body.athlete;
  if (!a || typeof a !== 'object' || !a.id) return res.status(400).json({ error: 'bad_input' });
  u.roster = u.roster || [];
  const i = u.roster.findIndex((x) => x.id === a.id);
  if (i >= 0) u.roster[i] = a; else u.roster.unshift(a);
  if (u.roster.length > 300) u.roster.length = 300;
  saveUsers();
  res.json({ ok: true });
});
app.post('/api/athlete/delete', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const id = req.body && req.body.id;
  u.roster = (u.roster || []).filter((x) => x.id !== id);
  saveUsers();
  res.json({ ok: true });
});

// Create (or refresh) a public share link for one athlete's plan.
app.post('/api/share', (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const id = req.body && req.body.athleteId;
  const rec = (u.roster || []).find((a) => a.id === id);
  if (!rec || !rec.plan) return res.status(400).json({ error: 'no_plan', message: 'Build the plan first, then send it.' });
  let token = rec.shareToken;
  if (!token) { token = crypto.randomBytes(9).toString('base64url'); rec.shareToken = token; saveUsers(); }
  SHARES[token] = {
    token, athleteName: rec.name || 'Athlete',
    form: rec.form || {}, plan: rec.plan, tests: rec.tests || [], gameWeek: rec.gameWeek || null,
    coach: { name: u.name || '', school: u.school || '', photo: u.photo || '' },
    at: Date.now(),
  };
  saveShares();
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
  const host = req.headers['host'];
  res.json({ ok: true, url: `${proto}://${host}/p/${token}`, token });
});

// Public read-only plan JSON (no auth) — the shared link fetches this.
app.get('/api/shared/:token', (req, res) => {
  const s = SHARES[req.params.token];
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, share: s });
});

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

  // --- trial gate: enforce BEFORE spending AI tokens ---
  let coachRec = userFromToken(tokenOf(req));
  if (TRIAL) {
    if (!coachRec) { const email = normEmail(b.coach && b.coach.email); if (email) coachRec = USERS[email]; }
    if (!coachRec) return res.status(401).json({ error: 'need_coach', message: 'Please sign in to build a plan.' });
    if (!coachRec.activated) {
      const expired = Date.now() - (coachRec.firstSeen || Date.now()) > TRIAL.days * 86400000;
      const overCap = (coachRec.plans || 0) >= TRIAL.plans;
      if (expired || overCap) {
        return res.status(402).json({
          error: 'trial_over', reason: expired ? 'time' : 'cap',
          message: expired ? `Your ${TRIAL.days}-day free trial has ended.` : `You've used all ${TRIAL.plans} trial plans.`,
        });
      }
    }
  }

  const equipment = ['gym', 'basic', 'home'].includes(b.equipment) ? b.equipment : 'gym';
  const injury = ['healthy', 'returning', 'injured'].includes(b.injury) ? b.injury : 'healthy';
  const injuryDesc = (b.injuryDesc || '').toString().slice(0, 200);

  // Prior test snapshots (for progression) — format each like the current metrics line.
  const histArr = Array.isArray(b.history) ? b.history.slice(-6) : [];
  const historyText = histArr.map((h) => {
    const mt = metricDefs
      .filter((m) => h && h.metrics && String(h.metrics[m.key]).trim() !== '')
      .map((m) => `${m.label}: ${String(h.metrics[m.key]).slice(0, 20)}${m.unit ? ' ' + m.unit : ''}`)
      .join(', ');
    const when = (h && h.date ? String(h.date).slice(0, 10) : '') || 'earlier';
    const wt = h && h.weightLb ? `${h.weightLb} lb` : '';
    const body = [wt, mt].filter(Boolean).join('; ');
    return body ? `  - ${when}: ${body}` : '';
  }).filter(Boolean).join('\n');

  const athlete = {
    name: (b.name || '').toString().slice(0, 80),
    age, sex, sport, diningHall: !!b.diningHall,
    restrictions: (b.restrictions || '').toString().slice(0, 300),
    notes: (b.notes || '').toString().slice(0, 300),
    metricsText, historyText, equipment, injury, injuryDesc,
  };

  try {
    const targets = computeTargets({ sex, age, heightCm, weightKg, activity, goal, profile });
    const plan = await generatePlan({ athlete, profile, targets });
    if (coachRec && !coachRec.activated) { coachRec.plans = (coachRec.plans || 0) + 1; saveUsers(); }
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

// --- activate: coach enters a code (given after they pay) to unlock unlimited use ---
app.post('/api/activate', (req, res) => {
  if (!TRIAL) return res.json({ ok: true }); // open brand — nothing to unlock
  const b = req.body || {};
  const u = userFromToken(tokenOf(req));
  const email = u ? u.email : normEmail((b.coach && b.coach.email) || b.email);
  const code = String(b.code || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'need_coach', message: 'Sign in first.' });
  if (!code || !ACTIVATION_CODES.has(code)) return res.status(400).json({ error: 'bad_code', message: 'That code isn’t valid.' });
  // single-use: a code can bind to only one coach
  for (const [em, rec] of Object.entries(USERS)) { if (rec.code === code && em !== email) return res.status(409).json({ error: 'code_used', message: 'That code is already in use.' }); }
  const rec = USERS[email] || (USERS[email] = { email, firstSeen: Date.now(), plans: 0 });
  rec.activated = true; rec.code = code; rec.activatedAt = Date.now();
  saveUsers();
  console.log('[activate]', email, 'code', code);
  res.json({ ok: true });
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

// POST /api/gameweek — a full game-week fueling + recovery timeline for one athlete.
app.post('/api/gameweek', async (req, res) => {
  if (!KEY_OK) return res.status(400).json({ error: 'no_api_key', message: 'Add your ANTHROPIC_API_KEY to .env and restart.' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').toString().split(',')[0].trim();
  if (!underLimit(ip, Number(process.env.FUEL_LIMIT || 30))) return res.status(429).json({ error: 'rate', message: 'Hit the hourly limit — give it a few minutes.' });
  const b = req.body || {};
  const age = num(b.age), heightCm = num(b.heightCm), weightKg = num(b.weightKg);
  const sex = b.sex === 'female' ? 'female' : 'male';
  if (!(age >= 10 && age <= 60) || !(heightCm >= 120 && heightCm <= 230) || !(weightKg >= 30 && weightKg <= 230)) return res.status(400).json({ error: 'bad_input', message: 'Build the athlete plan first.' });
  const sport = b.sport === 'track' ? 'track' : 'football';
  const profile = profileFor(sport, b.position);
  const goal = GOALS[b.goal] ? b.goal : profile.goalDefault;
  const activity = ACTIVITY[b.activity] ? b.activity : 'high';
  const gameDay = (b.gameDay || 'Saturday').toString().slice(0, 20);
  const injury = ['healthy', 'returning', 'injured'].includes(b.injury) ? b.injury : 'healthy';
  const athlete = { name: (b.name || '').toString().slice(0, 80), sport, diningHall: !!b.diningHall, injury };
  try {
    const targets = computeTargets({ sex, age, heightCm, weightKg, activity, goal, profile });
    const gameWeek = await generateGameWeek({ athlete, profile, targets, gameDay });
    res.json({ ok: true, gameWeek });
  } catch (e) {
    console.error('[gameweek]', e);
    res.status(500).json({ error: 'gw_failed', message: e.message });
  }
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
    .replace('</head>', `<style>:root{--accent:${B.accent}}</style><script>window.__BRAND=${JSON.stringify({ name: B.name, short: B.short, accent: B.accent, tagline: B.tagline, demos: B.demos, leadCapture: !!B.leadCapture, trial: TRIAL ? { days: TRIAL.days, plans: TRIAL.plans } : null })}</script></head>`);
})();
function serveIndex(_req, res) { res.type('html').send(INDEX_HTML); }
const PITCH_HTML = (() => {
  const B = BRAND;
  let h; try { h = fs.readFileSync(path.join(__dirname, 'public', 'pitch.html'), 'utf8'); } catch { return ''; }
  return h
    .replace('<title>XPI Athlete Fuel — for Coaches</title>', `<title>${B.name} — for Coaches</title>`)
    .split('/icons-xpi/favicon-64.png').join(B.iconDir + '/favicon-64.png')
    .replace('--accent:#F2A93B;', `--accent:${B.accent};`)
    .replace('XPI<span>&middot;</span> ATHLETE FUEL<small>ATHLETE PERFORMANCE</small>',
             `${B.markMain}<span>${B.markAccent}</span> ${B.markSub}<small>${(B.tagline || '').toUpperCase()}</small>`)
    .split('XPI Athlete Fuel gives a coach').join(`${B.name} gives a coach`)
    .split('https://athletefuel.xpisolutions.com').join('https://' + (B.site || 'athletefuel.xpisolutions.com'))
    .split('>athletefuel.xpisolutions.com<').join('>' + (B.site || 'athletefuel.xpisolutions.com') + '<');
})();
app.get('/', serveIndex);
app.get('/index.html', serveIndex);
app.get('/p/:token', serveIndex); // shared read-only plan (app renders it client-side)
app.get('/pitch', (_req, res) => res.type('html').send(PITCH_HTML || 'Pitch unavailable.'));
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
