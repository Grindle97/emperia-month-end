// End-to-end: the real server in DEMO_MODE (Sep 2026 workbook balances), driven
// over HTTP the way the dashboard does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}/api`;
let server;
let dataDir;

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperia-web-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, DEMO_MODE: '1', PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'test',
      DEV_USER_EMAIL: 'tester@emperiavr.com', USER_ROLES: 'tester@emperiavr.com:admin',
      ANTHROPIC_API_KEY: '', CF_ACCESS_AUD: '', CF_ACCESS_TEAM_DOMAIN: '',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => { if (server) server.kill(); });

test('October: prepayment releases appear as a journal, edits must balance, tracking is validated', async () => {
  const run = await call('POST', '/close/2026-10/run');
  assert.equal(run.status, 200);
  const j = run.json.journals.find((x) => /prepayment/i.test(x.narration) && x.entityKey === 'ltd');
  assert.ok(j, 'Ltd prepayment release journal shown');
  assert.equal(j.posted, false);
  assert.ok(run.json.tracking.ltd.length, 'tracking categories loaded');

  const unbalanced = await call('POST', `/close/2026-10/journals/${j.id}/edit`, {
    lines: [{ account: 'Bank Fees', debit: 90, credit: 0 }, { account: 'Prepayments', debit: 0, credit: 80 }],
  });
  assert.equal(unbalanced.status, 400);
  assert.match(unbalanced.json.error, /must be equal/);

  const badTrack = await call('POST', `/close/2026-10/journals/${j.id}/edit`, {
    lines: [{ account: 'Bank Fees', debit: 90, credit: 0, tracking: [{ name: 'Department', option: 'Nope' }] }, { account: 'Prepayments', debit: 0, credit: 90 }],
  });
  assert.equal(badTrack.status, 400);

  const ok = await call('POST', `/close/2026-10/journals/${j.id}/edit`, {
    lines: [
      { account: 'Bank Fees', description: 'Plan fee', debit: 90, credit: 0, tracking: [{ name: 'Department', option: 'Operations' }] },
      { account: 'Prepayments', description: 'Release', debit: 0, credit: 90 },
    ],
    note: 'test edit',
  });
  assert.equal(ok.status, 200);
  const edited = ok.json.journals.find((x) => x.id === j.id);
  assert.equal(edited.lines.length, 2);
  assert.deepEqual(edited.lines[0].tracking, [{ name: 'Department', option: 'Operations' }]);
  assert.ok(edited.originalLines.length > 2);

  const reverted = await call('POST', `/close/2026-10/journals/${j.id}/edit`, { revert: true });
  assert.equal(reverted.json.journals.find((x) => x.id === j.id).edit, null);
});

test('Schedules: historic accruals show the month, and items can be added and cleared', async () => {
  await call('POST', '/close/2026-10/run');
  const sc = await call('GET', '/close/2026-10/schedules');
  const acc = sc.json.entities.ltd.find((x) => x.register === 'accruals');
  assert.equal(acc.view, 'historic');
  const accountomate = acc.items.find((x) => x.item.supplier === 'Accountomate');
  assert.equal(accountomate.cells['2026-05'], 2000);
  assert.equal(acc.balance, 12531.46);
  assert.ok(sc.json.entities.ltd.some((x) => x.register === 'deferred-income'), 'nil income in advance schedule is listed');

  const add = await call('POST', '/close/2026-10/registers/ltd/accruals/items', { supplier: 'Audit fee', amount: '1,500', account: 'Audit & Accountancy Fees', period: '2026-10' });
  assert.equal(add.status, 200);
  const sc2 = await call('GET', '/close/2026-10/schedules');
  const acc2 = sc2.json.entities.ltd.find((x) => x.register === 'accruals');
  assert.equal(acc2.balance, 14031.46);
  assert.equal(acc2.items.find((x) => x.item.supplier === 'Audit fee').cells['2026-10'], 1500);

  const accId = accountomate.item.id;
  const cleared = await call('POST', `/close/2026-10/registers/ltd/accruals/items/${accId}/close`, { period: '2026-10' });
  assert.equal(cleared.status, 200);
  const sc3 = await call('GET', '/close/2026-10/schedules');
  assert.equal(sc3.json.entities.ltd.find((x) => x.register === 'accruals').balance, 12031.46);

  const pp = await call('POST', '/close/2026-10/registers/ltd/prepayments/items', {
    supplier: 'Annual licence', amount: 1200, account: 'IT - Software - Productivity', start: '2026-10-01', end: '2027-09-30', method: 'straight_line',
  });
  assert.equal(pp.status, 200);
  const sc4 = await call('GET', '/close/2026-10/schedules');
  const ppr = sc4.json.entities.ltd.find((x) => x.register === 'prepayments');
  const lic = ppr.items.find((x) => x.item.supplier === 'Annual licence');
  assert.equal(lic.item.monthlyRelease, 100);
  assert.equal(lic.balances['2026-10'], 1100);
});

test('Bank statements: upload is stored and can be opened; assistant off without a key', async () => {
  await call('POST', '/close/2026-10/run');
  const pdf = Buffer.from('%PDF-1.4 demo statement closing balance 8817.08');
  const up = await call('POST', '/close/2026-10/statement-file', { entity: 'ltd', account: 'Revolut GBP Main', filename: 'revolut-oct.pdf', contentType: 'application/pdf', data: pdf.toString('base64') });
  assert.equal(up.status, 200);
  assert.equal(up.json.statementFiles.ltd['Revolut GBP Main'].name, 'revolut-oct.pdf');
  const res = await fetch(`${BASE}/close/2026-10/statement-file/ltd?account=${encodeURIComponent('Revolut GBP Main')}`);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), pdf.toString());

  const bad = await call('POST', '/close/2026-10/statement-file', { entity: 'ltd', account: 'X', filename: 'x.exe', contentType: 'application/x-msdownload', data: 'AAAA' });
  assert.equal(bad.status, 400);

  const ask = await call('POST', '/close/2026-10/ask', { question: 'Anything to check?' });
  assert.equal(ask.status, 503);
});
