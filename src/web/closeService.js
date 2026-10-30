// What the dashboard does, independent of HTTP: run a close, re-apply inputs,
// and assemble the view (results + decisions + what still blocks sign-off).

const crypto = require('crypto');
const store = require('../store/store');
const { runClose, xeroSource } = require('../recon/close');
const { registerGrid, loadRegisters, addMonths } = require('../recon/registers');

const DONE = new Set(['Reconciled', 'Rounding', 'Explained']);

/** Wrap a source so every answer is kept; the snapshot replays the run offline. */
function recording(source) {
  const calls = {};
  const wrapped = {};
  for (const [name, fn] of Object.entries(source)) {
    wrapped[name] = async (...args) => {
      const value = await fn(...args);
      calls[`${name}:${JSON.stringify(args)}`] = value;
      return value;
    };
  }
  return { source: wrapped, snapshot: () => calls };
}

function replaying(calls) {
  const handler = (name) => async (...args) => {
    const key = `${name}:${JSON.stringify(args)}`;
    if (!(key in calls)) throw new Error(`Not in the saved Xero snapshot (${name}). Re-run the close to read Xero again.`);
    return calls[key];
  };
  return ['getAccounts', 'getTrialBalanceReport', 'getUnreconciledBankTransactions', 'getAgedDocuments']
    .reduce((s, n) => ({ ...s, [n]: handler(n) }), {});
}

function liveSource() {
  if (process.env.DEMO_MODE === '1') {
    // Demo: September balances from the analyst's workbooks, no Xero needed.
    const { demoSource } = require('../../test/fixtures');
    return demoSource();
  }
  return xeroSource();
}

async function compute(period, source) {
  const inputs = store.loadInputs(period);
  return runClose({
    period,
    source,
    usdGbp: inputs.fx.USDGBP,
    registerDir: store.PATHS.registers,
    inputDir: store.PATHS.inputs,
  });
}

/** Read Xero, reconcile, save. */
async function runFromXero(period, user) {
  store.assertPeriod(period);
  const rec = recording(liveSource());
  const results = await compute(period, rec.source);
  const run = { period, ranAt: new Date().toISOString(), ranBy: user.email, demo: process.env.DEMO_MODE === '1', results };
  store.saveSnapshot(period, rec.snapshot());
  store.saveRun(period, run);
  store.audit({ period, by: user.email, action: 'run', detail: 'Read Xero and reconciled both entities' });
  return run;
}

/** Re-apply inputs and explanations to the last Xero read. */
async function recompute(period) {
  const prev = store.loadRun(period);
  const snap = store.loadSnapshot(period);
  if (!prev || !snap) throw Object.assign(new Error('Run the close for this period first.'), { status: 409 });
  const results = await compute(period, replaying(snap));
  const run = { ...prev, results, recomputedAt: new Date().toISOString() };
  store.saveRun(period, run);
  return run;
}

const reviewKey = (row) => `${row.account}|${row.xero}`;

function resultsHash(run, entity) {
  const r = run.results[entity];
  const rows = r.rows.map((x) => [x.account, x.xero, x.supporting, x.status]);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 12);
}

/** The full picture for the UI. */
function view(period) {
  store.assertPeriod(period);
  const run = store.loadRun(period);
  const decisions = store.loadDecisions(period);
  const inputs = store.loadInputs(period);
  if (!run) return { period, run: null, decisions, inputs, periods: store.listPeriods() };

  const entities = {};
  const journals = [];
  for (const key of ['ltd', 'inc']) {
    const r = run.results[key];
    if (!r) continue;
    const reviews = (decisions.reviews && decisions.reviews[key]) || {};
    const rows = r.rows.map((row) => {
      const rv = reviews[row.account];
      const reviewed = rv && rv.key === reviewKey(row) ? rv : null;
      return { ...row, reviewed };
    });
    for (const j of r.journals) {
      const id = store.journalId(j);
      journals.push({ ...j, id, entityKey: key, decision: decisions.journals[id] || null });
    }
    const blockers = [];
    for (const row of rows) {
      if (DONE.has(row.status) || row.reviewed) continue;
      if (row.status === 'Journal proposed') {
        const js = journals.filter((j) => j.entityKey === key && j.lines.some((l) => l.account === row.account));
        if (js.length && js.every((j) => j.decision)) continue;
        blockers.push({ account: row.account, need: 'Decide the proposed journal' });
      } else if (row.status === 'Needs input') blockers.push({ account: row.account, need: 'Enter the missing input' });
      else if (row.status === 'Break') blockers.push({ account: row.account, need: 'Explain the difference or fix it in Xero' });
      else blockers.push({ account: row.account, need: 'Review and tick' });
    }
    const so = decisions.signoff && decisions.signoff[key];
    const hash = resultsHash(run, key);
    entities[key] = {
      ...r,
      rows,
      blockers,
      signoff: so ? { ...so, stale: so.hash !== hash } : null,
      counts: rows.reduce((m, x) => {
        const s = x.reviewed && !DONE.has(x.status) ? 'Reviewed' : x.status;
        return { ...m, [s]: (m[s] || 0) + 1 };
      }, {}),
    };
  }
  return {
    period,
    run: { ranAt: run.ranAt, ranBy: run.ranBy, recomputedAt: run.recomputedAt, demo: run.demo },
    entities,
    intercompany: run.results.intercompany || null,
    journals,
    decisions,
    inputs,
    periods: store.listPeriods(),
  };
}

function signoff(period, entity, user) {
  const v = view(period);
  const e = v.entities[entity];
  if (!e) throw Object.assign(new Error('No results for that entity.'), { status: 404 });
  if (e.blockers.length) throw Object.assign(new Error(`${e.blockers.length} item(s) still open.`), { status: 409 });
  const run = store.loadRun(period);
  store.updateDecisions(period, (d) => {
    d.signoff = d.signoff || {};
    d.signoff[entity] = { by: user.email, at: new Date().toISOString(), hash: resultsHash(run, entity) };
  });
  store.audit({ period, by: user.email, action: 'signoff', entity });
}

/**
 * Every register for both entities as a month-by-month grid, around `period`:
 * up to 11 months back (never before the register opens) and 6 forward.
 */
function schedules(period) {
  store.assertPeriod(period);
  const run = store.loadRun(period);
  const out = {};
  for (const key of ['ltd', 'inc']) {
    const rows = (run && run.results[key] && run.results[key].rows) || [];
    out[key] = loadRegisters(key, store.PATHS.registers).map((reg) => {
      const grid = registerGrid(reg, addMonths(period, -11), addMonths(period, 6));
      const row = rows.find((r) => r.account.toLowerCase() === String(reg.account).toLowerCase());
      return {
        register: reg.register, account: reg.account, side: reg.side, currency: reg.currency,
        notes: reg.notes || [], source: reg.source, ...grid,
        xero: row ? { [period]: row.xero } : {},
      };
    }).sort((a, b) => a.account.localeCompare(b.account));
  }
  return { period, entities: out };
}

module.exports = { runFromXero, recompute, view, signoff, schedules, reviewKey, recording, replaying };
