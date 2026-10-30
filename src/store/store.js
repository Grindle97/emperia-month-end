// Everything the dashboard reads and writes lives under DATA_DIR (default
// ./data; on Railway, the mounted volume):
//
//   registers/<entity>/*.json      live schedules (seeded once from repo registers/)
//   inputs/fx/<period>.json        month-end rates
//   inputs/statements/<entity>/<period>.json   bank statement balances
//   runs/<period>.json             latest results for the period
//   runs/<period>.source.json      the Xero data that run used, so inputs and
//                                  explanations can be applied without re-reading Xero
//   decisions/<period>.json        journal decisions, account reviews, sign-offs
//   audit.log                      one JSON line per action, never rewritten
//
// The repo's registers/ and inputs/ are only the starting point: once the data
// directory has been seeded, the dashboard's copy is the one that changes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PATHS = {
  registers: path.join(DATA_DIR, 'registers'),
  inputs: path.join(DATA_DIR, 'inputs'),
  runs: path.join(DATA_DIR, 'runs'),
  decisions: path.join(DATA_DIR, 'decisions'),
  audit: path.join(DATA_DIR, 'audit.log'),
};

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

/** First boot: copy the repo's opening registers and inputs into DATA_DIR. */
function ensureSeeded() {
  if (!fs.existsSync(PATHS.registers)) copyDir(path.join(ROOT, 'registers'), PATHS.registers);
  if (!fs.existsSync(PATHS.inputs)) copyDir(path.join(ROOT, 'inputs'), PATHS.inputs);
  for (const p of [PATHS.runs, PATHS.decisions]) fs.mkdirSync(p, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
  } catch (err) {
    console.error(`Could not read ${file}: ${err.message}`);
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash never leaves half a file. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const validPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p));
function assertPeriod(p) {
  if (!validPeriod(p)) throw Object.assign(new Error('Period must be YYYY-MM.'), { status: 400 });
}

// --- runs
const runFile = (p) => path.join(PATHS.runs, `${p}.json`);
const sourceFile = (p) => path.join(PATHS.runs, `${p}.source.json`);
function listPeriods() {
  if (!fs.existsSync(PATHS.runs)) return [];
  return fs.readdirSync(PATHS.runs).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 7)).sort().reverse();
}
const loadRun = (p) => readJson(runFile(p));
const saveRun = (p, run) => writeJson(runFile(p), run);
const loadSnapshot = (p) => readJson(sourceFile(p));
const saveSnapshot = (p, snap) => writeJson(sourceFile(p), snap);

// --- inputs
function loadInputs(period) {
  const fx = readJson(path.join(PATHS.inputs, 'fx', `${period}.json`), {});
  const statements = {};
  for (const key of ['ltd', 'inc']) {
    statements[key] = readJson(path.join(PATHS.inputs, 'statements', key, `${period}.json`), {});
  }
  return { fx, statements };
}
function saveFx(period, usdGbp, by) {
  const file = path.join(PATHS.inputs, 'fx', `${period}.json`);
  const cur = readJson(file, {});
  writeJson(file, { ...cur, USDGBP: usdGbp, enteredBy: by, enteredAt: new Date().toISOString() });
}
function saveStatement(period, entity, account, amount) {
  const file = path.join(PATHS.inputs, 'statements', entity, `${period}.json`);
  const cur = readJson(file, {});
  if (amount === null) delete cur[account];
  else cur[account] = amount;
  writeJson(file, cur);
}

// --- explanations (read by the engine from registers/<entity>/_explanations.json)
function saveExplanation(period, entity, account, difference, comment, by) {
  const file = path.join(PATHS.registers, entity, '_explanations.json');
  const all = readJson(file, {});
  all[period] = all[period] || {};
  if (!comment) delete all[period][account];
  else all[period][account] = { difference, comment, by, at: new Date().toISOString() };
  writeJson(file, all);
}

// --- decisions
const decisionsFile = (p) => path.join(PATHS.decisions, `${p}.json`);
function loadDecisions(period) {
  return readJson(decisionsFile(period), { journals: {}, reviews: { ltd: {}, inc: {} }, signoff: {} });
}
function updateDecisions(period, fn) {
  const d = loadDecisions(period);
  fn(d);
  writeJson(decisionsFile(period), d);
  return d;
}

// --- improvement suggestions from people using the dashboard
const feedbackFile = () => path.join(DATA_DIR, 'feedback.jsonl');
function addFeedback(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const rec = { id: crypto.randomBytes(6).toString('hex'), at: new Date().toISOString(), status: 'new', ...entry };
  fs.appendFileSync(feedbackFile(), `${JSON.stringify(rec)}\n`);
  return rec;
}
function readFeedback() {
  if (!fs.existsSync(feedbackFile())) return [];
  const items = fs.readFileSync(feedbackFile(), 'utf-8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Later lines with the same id update status (append-only file).
  const byId = new Map();
  for (const it of items) byId.set(it.id, { ...(byId.get(it.id) || {}), ...it });
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at));
}

// --- audit
function audit(entry) {
  fs.mkdirSync(path.dirname(PATHS.audit), { recursive: true });
  fs.appendFileSync(PATHS.audit, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
function readAudit(period, limit = 200) {
  if (!fs.existsSync(PATHS.audit)) return [];
  return fs.readFileSync(PATHS.audit, 'utf-8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && (!period || e.period === period))
    .slice(-limit).reverse();
}

/** Stable id for a proposed journal, so a decision survives a re-run. */
function journalId(j) {
  const key = JSON.stringify([j.entity, j.date, j.narration, j.lines.map((l) => [l.account, l.debit, l.credit])]);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

module.exports = {
  DATA_DIR, PATHS, ensureSeeded, validPeriod, assertPeriod,
  listPeriods, loadRun, saveRun, loadSnapshot, saveSnapshot,
  loadInputs, saveFx, saveStatement, saveExplanation,
  loadDecisions, updateDecisions, audit, readAudit, journalId, addFeedback, readFeedback,
};
