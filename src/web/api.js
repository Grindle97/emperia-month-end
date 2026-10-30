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
const ai = require('../ai/assistant');
const comments = require('./comments');

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

// Comments and suggestions. Anyone signed in can leave one, pinned to a place
// on the page (anchor) or general, and reply to an existing one (parent).
router.post('/feedback', wrap(async (req, res) => {
  const text1 = text(req.body.text, 4000);
  if (!text1) throw bad('Write the comment first.');
  const parentId = req.body.parent ? String(req.body.parent) : null;
  if (parentId) {
    const parent = store.readFeedback().find((f) => f.id === parentId && !f.parent);
    if (!parent) throw bad('That comment no longer exists.');
    const rec = store.addFeedback({ by: req.user.email, text: text1, parent: parentId, kind: 'reply' });
    // A reply reopens a resolved comment so it is not missed.
    if (!comments.OPEN.has(parent.status)) store.addFeedback({ id: parentId, status: 'new', at: undefined });
    return res.json({ ok: true, id: rec.id, feedback: store.readFeedback() });
  }
  const rec = store.addFeedback({
    by: req.user.email, text: text1,
    kind: ['idea', 'problem', 'question'].includes(req.body.kind) ? req.body.kind : 'idea',
    context: text(req.body.context, 300),
    anchor: comments.cleanAnchor(req.body.anchor),
    period: /^\d{4}-\d{2}$/.test(req.body.period || '') ? req.body.period : null,
  });
  res.json({ ok: true, id: rec.id, feedback: store.readFeedback() });
}));
router.get('/feedback', wrap(async (req, res) => res.json({ feedback: store.readFeedback() })));
// Markdown brief of the comments, to paste back to Claude.
router.get('/feedback/export', wrap(async (req, res) => {
  const status = req.query.status === 'all' ? 'all' : 'open';
  const md = comments.toMarkdown(store.readFeedback(), { status, appUrl: process.env.PUBLIC_URL || '' });
  if (req.query.download) res.set('Content-Disposition', `attachment; filename="emperia-close-comments-${new Date().toISOString().slice(0, 10)}.md"`);
  res.type('text/markdown; charset=utf-8').send(md);
}));
router.post('/feedback/:id', requireCapability('admin'), wrap(async (req, res) => {
  const status = ['new', 'planned', 'done', 'declined'].includes(req.body.status) ? req.body.status : null;
  if (!status) throw bad('Unknown status.');
  if (!store.readFeedback().some((f) => f.id === req.params.id && !f.parent)) throw bad('Not found.');
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

// ---------- journals: edit lines, ask the assistant

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Validate and clean journal lines. Throws a 400 with the reason. */
function cleanLines(lines, period, entityKey, trackingCats) {
  if (!Array.isArray(lines) || lines.length < 2) throw bad('A journal needs at least two lines.');
  if (lines.length > 60) throw bad('Too many lines.');
  const names = new Set(svc.chart(period, entityKey).map((a) => a.name.toLowerCase()));
  const out = lines.map((l, i) => {
    const account = text(l.account, 200);
    if (!account) throw bad(`Line ${i + 1}: choose an account.`);
    if (names.size && !names.has(account.toLowerCase())) throw bad(`Line ${i + 1}: "${account}" is not an active account in Xero.`);
    const debit = round2(l.debit);
    const credit = round2(l.credit);
    if (debit < 0 || credit < 0) throw bad(`Line ${i + 1}: amounts must be positive; use the other column.`);
    if ((debit > 0) === (credit > 0)) throw bad(`Line ${i + 1}: enter either a debit or a credit.`);
    const tracking = (Array.isArray(l.tracking) ? l.tracking : [])
      .filter((t) => t && t.name && t.option)
      .map((t) => ({ name: text(t.name, 100), option: text(t.option, 100) }));
    for (const t of tracking) {
      const cat = (trackingCats || []).find((c) => c.name === t.name);
      if (!cat || !cat.options.includes(t.option)) throw bad(`Line ${i + 1}: "${t.option}" is not an option of ${t.name}.`);
    }
    return { account, description: text(l.description, 300), debit, credit, tracking };
  });
  const dr = round2(out.reduce((t, l) => t + l.debit, 0));
  const cr = round2(out.reduce((t, l) => t + l.credit, 0));
  if (dr !== cr) throw bad(`Debits (${dr.toFixed(2)}) and credits (${cr.toFixed(2)}) must be equal.`);
  return out;
}

function findJournal(period, id) {
  const v = svc.view(period);
  const j = (v.journals || []).find((x) => x.id === id);
  if (!j) throw bad('That journal is no longer proposed. Refresh the page.');
  return { v, j };
}

router.get('/close/:period/accounts/:entity', requireCapability('view'), wrap(async (req, res) => {
  if (!ENTITY.has(req.params.entity)) throw bad('Unknown entity.');
  res.json({ accounts: svc.chart(req.params.period, req.params.entity) });
}));

router.post('/close/:period/journals/:id/edit', requireCapability('review'), wrap(async (req, res) => {
  const { period, id } = req.params;
  const { v, j } = findJournal(period, id);
  if (req.body.revert === true) {
    store.updateDecisions(period, (d) => { if (d.edits) delete d.edits[id]; delete d.journals[id]; });
    store.audit({ period, by: req.user.email, action: 'journal-reverted', entity: j.entityKey, detail: j.narration });
    return res.json(svc.view(period));
  }
  const lines = cleanLines(req.body.lines, period, j.entityKey, (v.tracking || {})[j.entityKey]);
  const note = text(req.body.note, 500);
  store.updateDecisions(period, (d) => {
    d.edits = d.edits || {};
    d.edits[id] = { lines, by: req.user.email, at: new Date().toISOString(), note };
    delete d.journals[id]; // lines changed: any earlier approval no longer applies
  });
  store.audit({ period, by: req.user.email, action: 'journal-edited', entity: j.entityKey, detail: `${j.narration}${note ? `: ${note}` : ''}` });
  res.json(svc.view(period));
}));

// Ask about one journal (id) or the whole close (id = "general").
router.post('/close/:period/ask', requireCapability('view'), wrap(async (req, res) => {
  const { period } = req.params;
  if (!ai.configured()) throw Object.assign(new Error('The assistant is off: add ANTHROPIC_API_KEY (an Emperia key) to the app settings.'), { status: 503 });
  const question = text(req.body.question, 2000);
  if (!question) throw bad('Type a question first.');
  const id = req.body.journalId ? String(req.body.journalId) : 'general';
  const v = svc.view(period);
  if (!v.run) throw bad('Run the close first.');
  const ctx = { period };
  let entityKey = 'ltd';
  if (id !== 'general') {
    const j = (v.journals || []).find((x) => x.id === id);
    if (!j) throw bad('That journal is no longer proposed. Refresh the page.');
    entityKey = j.entityKey;
    ctx.journal = j;
    const accts = new Set(j.lines.map((l) => l.account.toLowerCase()));
    ctx.rows = v.entities[entityKey].rows.filter((r) => accts.has(r.account.toLowerCase()));
    if (j.entityKey === 'ltd' && v.intercompany && j.lines.some((l) => /intercompany/i.test(l.account))) {
      ctx.summary = `Intercompany: ${v.intercompany.comment}`;
    }
  } else {
    ctx.summary = ['ltd', 'inc'].map((k) => {
      const e = v.entities[k];
      if (!e) return '';
      const open = e.rows.filter((r) => !['Reconciled', 'Rounding'].includes(r.status))
        .map((r) => `  ${r.account}: ${r.status}, Xero ${r.xero}${r.difference !== null ? `, difference ${r.difference}` : ''}. ${r.comment}`);
      return `${e.entity.label}:\n${open.join('\n')}`;
    }).join('\n') + `\nJournals: ${(v.journals || []).map((j) => `${j.narration} (${j.decision ? j.decision.decision : j.posted ? 'already in Xero' : 'awaiting decision'})`).join('; ')}`;
  }
  ctx.chart = svc.chart(period, entityKey).map((a) => a.name);
  ctx.chartEntity = entityKey === 'ltd' ? 'Emperia Ltd' : 'Emperia VR Inc';
  if ((v.tracking || {})[entityKey] && v.tracking[entityKey].length) {
    ctx.summary = `${ctx.summary || ''}\nTracking categories: ${v.tracking[entityKey].map((c) => `${c.name} (${c.options.join(', ')})`).join('; ')}`;
  }
  const history = (v.decisions.chats || {})[id] || [];
  let result;
  try {
    result = await ai.ask(ctx, question, history);
  } catch (err) {
    if (err.status === 503) throw err;
    console.error('Assistant failed:', err.message);
    throw Object.assign(new Error('The assistant could not answer just now. Try again in a moment.'), { status: 502 });
  }
  const now = new Date().toISOString();
  store.updateDecisions(period, (d) => {
    d.chats = d.chats || {};
    d.chats[id] = [...(d.chats[id] || []),
      { role: 'user', by: req.user.email, at: now, text: question },
      { role: 'assistant', at: new Date().toISOString(), text: result.answer, suggestion: result.suggestion }].slice(-40);
  });
  store.audit({ period, by: req.user.email, action: 'ask', detail: question.slice(0, 120) });
  res.json(svc.view(period));
}));

// ---------- bank statements: upload, view, read the balance

const STATEMENT_TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'text/csv': 'csv', 'application/vnd.ms-excel': 'csv', 'text/plain': 'txt' };

router.post('/close/:period/statement-file', requireCapability('input'), wrap(async (req, res) => {
  const { period } = req.params;
  const { entity, account, filename, contentType } = req.body;
  if (!ENTITY.has(entity)) throw bad('Unknown entity.');
  if (!STATEMENT_TYPES[contentType]) throw bad('Upload a PDF, PNG, JPG or CSV statement.');
  const buffer = Buffer.from(String(req.body.data || ''), 'base64');
  if (!buffer.length) throw bad('The file is empty.');
  if (buffer.length > 10 * 1024 * 1024) throw bad('Keep statements under 10 MB.');
  let extracted = null;
  if (ai.configured()) {
    try {
      const v = svc.view(period);
      extracted = await ai.readStatement({
        buffer, mediaType: contentType, account: text(account, 200),
        end: v.entities && v.entities[entity] ? v.entities[entity].end : period,
        currency: entity === 'ltd' ? 'GBP (or the account currency)' : 'USD',
      });
    } catch (err) {
      console.warn('Statement reading failed:', err.message);
      extracted = { found: false, note: 'Could not read the balance automatically. Enter it by hand.' };
    }
  }
  store.saveStatementFile(period, entity, text(account, 200), { filename: text(filename, 200) || 'statement', contentType, buffer, by: req.user.email, extracted });
  store.audit({ period, by: req.user.email, action: 'statement-file', entity, account, detail: text(filename, 200) });
  res.json({ ...svc.view(period), extracted });
}));

router.get('/close/:period/statement-file/:entity', requireCapability('view'), wrap(async (req, res) => {
  const f = store.statementFilePath(req.params.period, req.params.entity, String(req.query.account || ''));
  if (!f) return res.status(404).json({ error: 'No statement uploaded for that account.' });
  res.type(f.meta.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${f.meta.name.replace(/[^\w.\- ]/g, '_')}"`);
  res.sendFile(f.full);
}));

// ---------- schedules: add items, add entries, close items

function monthsBetween(start, end) {
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  return Math.max(1, Math.round(days / 30.4375));
}
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) && !Number.isNaN(Date.parse(d));

async function afterRegisterChange(period) {
  if (store.loadRun(period)) await svc.recompute(period);
}

router.post('/close/:period/registers/:entity/:name/items', requireCapability('input'), wrap(async (req, res) => {
  const { period, entity, name } = req.params;
  const b = req.body;
  const label = text(b.supplier || b.description, 200);
  if (!label) throw bad('Give the item a supplier or description.');
  const amount = money(b.amount);
  if (!amount) throw bad('Enter an amount.');
  const tracking = (Array.isArray(b.tracking) ? b.tracking : []).filter((t) => t && t.name && t.option).map((t) => ({ name: text(t.name, 100), option: text(t.option, 100) }));
  const id = `${entity}-${name}-${Date.now().toString(36)}`;
  let summary;
  store.updateRegister(entity, name, req.user.email, (reg) => {
    const historic = reg.view === 'historic' || (reg.view !== 'release' && (reg.items || []).every((i) => i.method === 'static'));
    let item;
    if (historic) {
      const p = b.period && isMonth(b.period) ? b.period : period;
      item = { id, supplier: label, expenseAccount: text(b.account, 200) || undefined, method: 'static', entries: [{ period: p, amount, note: text(b.note, 200) || 'added' }], tracking };
      summary = `${label} ${amount} in ${p}`;
    } else {
      if (!isDate(b.start) || !isDate(b.end) || b.end < b.start) throw bad('Enter the service start and end dates (end on or after start).');
      const method = b.method === 'on_end_date' ? 'on_end_date' : 'straight_line';
      const monthly = method === 'straight_line' ? round2(b.monthlyRelease ? money(b.monthlyRelease) : amount / monthsBetween(b.start, b.end)) : null;
      item = {
        id, supplier: label, invoiceNumber: text(b.invoiceNumber, 100) || undefined, invoiceDate: isDate(b.invoiceDate) ? b.invoiceDate : undefined,
        [reg.side === 'liability' ? 'revenueAccount' : 'expenseAccount']: text(b.account, 200) || undefined,
        amount, start: b.start, end: b.end, method, monthlyRelease: monthly, bookedPeriod: isMonth(b.bookedPeriod) ? b.bookedPeriod : period, tracking,
      };
      summary = `${label} ${amount}, ${b.start} to ${b.end}`;
    }
    reg.items = [...(reg.items || []), item];
  });
  store.audit({ period, by: req.user.email, action: 'register-add', entity, account: name, detail: summary });
  await afterRegisterChange(period);
  res.json(svc.view(period));
}));

router.post('/close/:period/registers/:entity/:name/items/:id/entry', requireCapability('input'), wrap(async (req, res) => {
  const { period, entity, name, id } = req.params;
  const amount = money(req.body.amount);
  if (!amount) throw bad('Enter an amount (negative to release).');
  const p = isMonth(req.body.period) ? req.body.period : period;
  store.updateRegister(entity, name, req.user.email, (reg) => {
    const it = (reg.items || []).find((x) => x.id === id);
    if (!it) throw bad('Item not found.');
    if (it.method !== 'static') throw bad('Only held items (accruals, deposits) take manual entries.');
    if (!it.entries || !it.entries.length) it.entries = [{ period: 'b/f', amount: it.openingBalance || 0, note: 'brought forward' }];
    it.entries.push({ period: p, amount, note: text(req.body.note, 200) || (amount < 0 ? 'released' : 'added') });
  });
  store.audit({ period, by: req.user.email, action: 'register-entry', entity, account: name, detail: `${id} ${amount} in ${p}` });
  await afterRegisterChange(period);
  res.json(svc.view(period));
}));

router.post('/close/:period/registers/:entity/:name/items/:id/close', requireCapability('input'), wrap(async (req, res) => {
  const { period, entity, name, id } = req.params;
  const undo = req.body.undo === true;
  store.updateRegister(entity, name, req.user.email, (reg) => {
    const it = (reg.items || []).find((x) => x.id === id);
    if (!it) throw bad('Item not found.');
    if (undo) delete it.closedPeriod; else it.closedPeriod = isMonth(req.body.period) ? req.body.period : period;
  });
  store.audit({ period, by: req.user.email, action: undo ? 'register-reopen' : 'register-close', entity, account: name, detail: id });
  await afterRegisterChange(period);
  res.json(svc.view(period));
}));

module.exports = router;
