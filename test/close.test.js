const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runClose, STATUS } = require('../src/recon/close');
const { fixtureSource } = require('./fixtures');

const REG = path.join(__dirname, '..', 'registers');
const INPUTS = path.join(__dirname, '..', 'inputs');

// Ltd aged payables at 30 Sep 2026, per the analyst's Trade creditors tab.
const bill = (contact, total, date = '2026-09-15', due = '2026-10-15') =>
  ({ contact: { name: contact }, total, date, dueDate: due, payments: [], currencyCode: 'GBP', currencyRate: 1 });
const LTD_AP = {
  invoices: [
    bill('Amazon Web Services', 1940.51),
    bill('F. INITIATIVES LIMITED', 4158.0),
    bill('Google', 308.59),
    bill('Rebank Technologies Limited', 12212.96, '2026-08-10', '2026-08-20'),
    bill('RORA - Quantico Analytics Limited', 4380.0),
    bill('Sohoworks', 330.0, '2026-05-01', '2026-06-01'),
    bill('Unconditionally Human Ltd', 360.0),
  ],
  credits: [{ contact: { name: 'Ahmad Sarfraz' }, total: 1716.26, date: '2025-01-10', allocations: [], payments: [], _kind: 'credit note' }],
};

async function sep() {
  return runClose({
    period: '2026-09', registerDir: REG, inputDir: INPUTS,
    source: fixtureSource({ aged: { ltd: { ACCPAY: LTD_AP } } }),
  });
}
const row = (res, key, name) => res[key].rows.find((r) => r.account === name);

test('September: reproduces the intercompany FX break and proposes the journal', async () => {
  const res = await sep();
  assert.equal(res.intercompany.rate, 0.753886);
  assert.equal(res.intercompany.expectedGbp, 2039089.92);
  assert.equal(res.intercompany.difference, 30571.26);
  const j = res.intercompany.journal;
  assert.ok(j, 'journal proposed');
  assert.deepEqual(j.lines.map((l) => [l.account, l.debit, l.credit]), [
    ['Intercompany - Emperia VR Inc', 30571.26, 0],
    ['Unrealised Currency Gains', 0, 30571.26],
  ]);
  assert.equal(row(res, 'ltd', 'Intercompany - Emperia VR Inc').status, STATUS.JOURNAL);
});

test('September: Ltd schedules tie, and the known breaks are flagged', async () => {
  const res = await sep();
  for (const name of ['Accruals', 'Deposits', 'Overseas worker employment deposit', "Directors' Loan Account", 'Other debtors', 'Income in Advance']) {
    assert.equal(row(res, 'ltd', name).status, STATUS.RECONCILED, name);
  }
  const pp = row(res, 'ltd', 'Prepayments');
  assert.equal(pp.status, STATUS.ROUNDING);
  assert.equal(pp.difference, 0.1);
  const ct = row(res, 'ltd', 'Provision for Corporation Tax');
  assert.equal(ct.status, STATUS.BREAK);
  assert.equal(ct.difference, -83425.27);
  const ap = row(res, 'ltd', 'Accounts Payable');
  assert.equal(ap.supporting, 21973.8);
  assert.equal(ap.status, STATUS.RECONCILED);
  assert.equal(row(res, 'ltd', 'Revolut GBP Main').status, STATUS.INPUT, 'bank needs a statement balance');
});

test('September: Inc accrued income break is explained, deferred revenue is rounding', async () => {
  const res = await sep();
  const ai = row(res, 'inc', 'Accrued Income');
  assert.equal(ai.difference, 172356.52);
  assert.equal(ai.status, STATUS.EXPLAINED);
  assert.match(ai.comment, /Walmart/);
  const di = row(res, 'inc', 'Income in Advance');
  assert.equal(di.status, STATUS.ROUNDING);
  assert.equal(row(res, 'inc', 'Prepayments').status, STATUS.RECONCILED);
  assert.equal(row(res, 'inc', "Directors' Loan Account").status, STATUS.REVIEW);
});

test('October: unposted prepayment releases become a proposed journal', async () => {
  // Xero still at the September balance at 31 Oct, i.e. no releases posted.
  const res = await runClose({
    period: '2026-10', entities: ['ltd'], registerDir: REG, inputDir: INPUTS,
    source: fixtureSource({ aged: { ltd: { ACCPAY: LTD_AP } } }),
  });
  const pp = row(res, 'ltd', 'Prepayments');
  assert.equal(pp.supporting, 9428.18);
  assert.equal(pp.status, STATUS.JOURNAL);
  const j = res.ltd.journals.find((x) => /prepayment/i.test(x.narration));
  const dr = j.lines.reduce((s, l) => s + l.debit, 0);
  const cr = j.lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(Math.round(dr * 100), Math.round(cr * 100), 'journal balances');
  assert.equal(Math.round(cr * 100) / 100, 1527.32);
  assert.ok(j.lines.some((l) => l.account === 'Bank Fees' && l.debit === 90));
});
