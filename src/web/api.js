// JSON API behind the dashboard. Every route sits behind requireUser (server.js)
// and checks its own capability. Nothing here writes to Xero: approving a
// journal records the decision only (posting arrives in phase 3).

const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const store = require('../store/store');
const svc = require('./closeService');
const { requireCapability } = require('../auth/access');
const { writeEntityPack } = require('../output/pack');

const router = express.Router();
const ENTITY = new Set(['ltd', 'inc']);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  const status = err.status || 500;
  if (status >= 500) console.error(`${req.method} ${req.path}:`, err.message);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function money(v, { allowNull = false } = {}) {
  if (allowNull && (v === null || v === '')) return null;
  const n = Number(String(v).replace(/[,£$\s]/g, ''));
  if (!Number.isFinite(n)) throw bad('Enter a number.');
  return Math.round(n * 100) / 100;
}

function text(v, max = 1000) {
  const s = String(v || '').trim();
  if (s.length > max) throw bad(`Keep it under ${max} characters.`);
  return s;
}

router.param('period', (req, res, next, p) => (store.validPeriod(p) ? next() : res.status(400).json({ error: 'Period must be YYYY-MM.' })));

router.get('/me', (req, res) => res.json({ email: req.user.email, role: req.user.role, capabilities: req.user.capabilities, demo: process.env.DEMO_MODE === '1' }));

router.get('/periods', (req, res) => res.json({ periods: store.listPeriods() }));

router.get('/close/:period', requireCapability('view'), wrap(async (req, res) => {
  res.json(svc.view(req.params.period));
}));

// Read Xero and reconcile. Takes 10-60 seconds.
let running = null;
router.post('/close/:period/run', requireCapability('run'), wrap(async (req, res) => {
  if (running) return res.status(409).json({ error: `A close for ${running} is already running.` });
  running = req.params.period;
  try {
    await svc.runFromXero(req.params.period, req.user);
  } finally {
    running = null;
  }
  res.json(svc.view(req.params.period));
}));

router.put('/close/:period/fx', requireCapability('input'), wrap(async (req, res) => {
  const rate = Number(req.body.usdGbp);
  if (!(rate > 0.3 && rate < 1.5)) throw bad('USD/GBP should be GBP per 1 USD, e.g. 0.7539.');
  store.saveFx(req.params.period, rate, req.user.email);
  store.audit({ period: req.params.period, by: req.user.email, action: 'fx', detail: `USD/GBP ${rate}` });
  await svc.recompute(req.params.period);
  res.json(svc.view(req.params.period));
}));

router.put('/close/:period/statement', requireCapability('input'), wrap(async (req, res) => {
  const { entity, account } = req.body;
  if (!ENTITY.has(entity)) throw bad('Unknown entity.');
  const amount = money(req.body.amount, { allowNull: true });
  store.saveStatement(req.params.period, entity, text(account, 200), amount);
  store.audit({ period: req.params.period, by: req.user.email, action: 'statement', entity, account, detail: amount === null ? 'cleared' : String(amount) });
  await svc.recompute(req.params.period);
  res.json(svc.view(req.params.period));
}));

router.post('/close/:period/explain', requireCapability('explain'), wrap(async (req, res) => {
  const { entity, account } = req.body;
  if (!ENTITY.has(entity)) throw bad('Unknown entity.');
  const comment = text(req.body.comment);
  store.saveExplanation(req.params.period, entity, text(account, 200), money(req.body.difference), comment, req.user.email);
  store.audit({ period: req.params.period, by: req.user.email, action: comment ? 'explain' : 'explain-cleared', entity, account, detail: comment });
  await svc.recompute(req.params.period);
  res.json(svc.view(req.params.period));
}));

router.post('/close/:period/review', requireCapability('review'), wrap(async (req, res) => {
  const { entity, account } = req.body;
  if (!ENTITY.has(entity)) throw bad('Unknown entity.');
  const v = svc.view(req.params.period);
  const row = v.entities[entity] && v.entities[entity].rows.find((r) => r.account === account);
  if (!row) throw bad('Account not found in this close.');
  const note = text(req.body.note);
  const undo = req.body.undo === true;
  store.updateDecisions(req.params.period, (d) => {
    d.reviews = d.reviews || {};
    d.reviews[entity] = d.reviews[entity] || {};
    if (undo) delete d.reviews[entity][account];
    else d.reviews[entity][account] = { by: req.user.email, at: new Date().toISOString(), note, key: svc.reviewKey(row) };
  });
  store.audit({ period: req.params.period, by: req.user.email, action: undo ? 'review-undone' : 'review', entity, account, detail: note });
  res.json(svc.view(req.params.period));
}));

router.post('/close/:period/journals/:id', requireCapability('approve'), wrap(async (req, res) => {
  const v = svc.view(req.params.period);
  const j = v.journals.find((x) => x.id === req.params.id);
  if (!j) throw bad('That journal is no longer proposed. Refresh the page.');
  const decision = req.body.decision;
  if (!['approved', 'rejected', 'undo'].includes(decision)) throw bad('Decision must be approved or rejected.');
  const note = text(req.body.note);
  if (decision === 'rejected' && !note) throw bad('Say why it is rejected.');
  store.updateDecisions(req.params.period, (d) => {
    if (decision === 'undo') delete d.journals[j.id];
    else d.journals[j.id] = { decision, by: req.user.email, at: new Date().toISOString(), note, journal: { entity: j.entity, narration: j.narration, lines: j.lines } };
  });
  store.audit({ period: req.params.period, by: req.user.email, action: `journal-${decision}`, entity: j.entityKey, detail: `${j.narration}${note ? `: ${note}` : ''}` });
  res.json(svc.view(req.params.period));
}));

router.post('/close/:period/signoff', requireCapability('signoff'), wrap(async (req, res) => {
  if (!ENTITY.has(req.body.entity)) throw bad('Unknown entity.');
  svc.signoff(req.params.period, req.body.entity, req.user);
  res.json(svc.view(req.params.period));
}));

router.get('/close/:period/schedules', requireCapability('view'), wrap(async (req, res) => {
  res.json(svc.schedules(req.params.period));
}));

// Suggestions for improving the tool. Anyone signed in can leave one.
router.post('/feedback', wrap(async (req, res) => {
  const text1 = text(req.body.text, 4000);
  if (!text1) throw bad('Write the suggestion first.');
  const rec = store.addFeedback({
    by: req.user.email, text: text1,
    kind: ['idea', 'problem', 'question'].includes(req.body.kind) ? req.body.kind : 'idea',
    context: text(req.body.context, 300),
  });
  res.json({ ok: true, id: rec.id });
}));
router.get('/feedback', wrap(async (req, res) => res.json({ feedback: store.readFeedback() })));
router.post('/feedback/:id', requireCapability('admin'), wrap(async (req, res) => {
  const status = ['new', 'planned', 'done', 'declined'].includes(req.body.status) ? req.body.status : null;
  if (!status) throw bad('Unknown status.');
  if (!store.readFeedback().some((f) => f.id === req.params.id)) throw bad('Not found.');
  const reply = text(req.body.reply, 1000);
  store.addFeedback({ id: req.params.id, status, reply, updatedBy: req.user.email, at: undefined });
  res.json({ feedback: store.readFeedback() });
}));

router.get('/close/:period/activity', requireCapability('view'), wrap(async (req, res) => {
  res.json({ activity: store.readAudit(req.params.period) });
}));

router.get('/close/:period/pack/:entity', requireCapability('view'), wrap(async (req, res) => {
  const { period, entity } = req.params;
  if (!ENTITY.has(entity)) throw bad('Unknown entity.');
  const run = store.loadRun(period);
  if (!run || !run.results[entity]) throw Object.assign(new Error('Run the close first.'), { status: 404 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  try {
    const file = await writeEntityPack(run.results[entity], run.results.intercompany, dir, { registerDir: store.PATHS.registers });
    res.download(file, path.basename(file), () => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}));

module.exports = router;
