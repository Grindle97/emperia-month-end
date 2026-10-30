const test = require('node:test');
const assert = require('node:assert/strict');
const { assertOnlyEmperia } = require('../src/config/entities');
const { itemSchedule } = require('../src/recon/registers');
const { invoiceOutstandingAt, agedAt } = require('../src/recon/agedLedger');
const { parseTrialBalance } = require('../src/recon/trialBalance');
const { tbReport, LTD } = require('./fixtures');

test('guard: only Emperia organisations are accepted', () => {
  assert.ok(assertOnlyEmperia([{ tenantName: 'Emperia Ltd' }, { tenantName: 'Emperia VR Inc' }], { requireAll: true }));
  assert.ok(assertOnlyEmperia([{ tenantName: 'EMPERIA LIMITED' }]));
  assert.throws(() => assertOnlyEmperia([{ tenantName: 'Emperia Ltd' }, { tenantName: 'Some Other Client Ltd' }]), /not Emperia: Some Other Client Ltd/);
  assert.throws(() => assertOnlyEmperia([{ tenantName: 'Emperia Ltd' }], { requireAll: true }), /Not connected to: Emperia VR Inc/);
});

test('register: straight line releases monthly and clears the remainder in the end month', () => {
  const item = { method: 'straight_line', start: '2026-03-10', end: '2027-03-09', monthlyRelease: 109.15, openingBalance: 654.9 };
  const r = itemSchedule(item, '2026-09-30', '2027-04');
  assert.equal(r.balance, 0);
  assert.equal(r.releases['2026-10'], 109.15);
  assert.equal(r.releases['2027-03'], 109.15);
  assert.equal(Object.keys(r.releases).length, 6);
});

test('register: future-start item waits for its start month; on_end_date releases once', () => {
  const plan = { method: 'straight_line', start: '2026-10-01', end: '2027-09-30', monthlyRelease: 90, openingBalance: 1080 };
  assert.equal(itemSchedule(plan, '2026-09-30', '2026-09').balance, 1080);
  assert.equal(itemSchedule(plan, '2026-09-30', '2026-12').balance, 810);
  const event = { method: 'on_end_date', end: '2027-01-12', openingBalance: 14150 };
  assert.equal(itemSchedule(event, '2026-09-30', '2026-12').balance, 14150);
  assert.equal(itemSchedule(event, '2026-09-30', '2027-01').releases['2027-01'], 14150);
});

test('register: an item booked later counts from its booked month and can release in it', () => {
  const item = { bookedPeriod: '2026-11', amount: 1200, method: 'straight_line', start: '2026-11-01', end: '2027-10-31', monthlyRelease: 100 };
  assert.equal(itemSchedule(item, '2026-09-30', '2026-10').balance, 0);
  assert.equal(itemSchedule(item, '2026-09-30', '2026-11').balance, 1100);
});

test('register: a closed item drops out in its closed month', () => {
  const acc = { method: 'static', openingBalance: 2000, closedPeriod: '2026-11' };
  assert.equal(itemSchedule(acc, '2026-09-30', '2026-10').balance, 2000);
  assert.equal(itemSchedule(acc, '2026-09-30', '2026-11').balance, 0);
});

test('aged ledger: payments after month end do not reduce the month-end balance', () => {
  const inv = { total: 1000, date: '2026-09-10', payments: [{ date: '/Date(1790000000000+0000)/', amount: 400 }, { date: '2026-10-05', amount: 600 }] };
  // 1790000000000 ms = 2026-09-21
  assert.equal(invoiceOutstandingAt(inv, '2026-09-30'), 600);
  assert.equal(invoiceOutstandingAt(inv, '2026-10-31'), 0);
});

test('aged ledger: foreign currency converts at the document rate; credits reduce', () => {
  const res = agedAt({
    invoices: [{ contact: { name: 'US Vendor' }, total: 1300, date: '2026-09-01', dueDate: '2026-09-15', payments: [], currencyCode: 'USD', currencyRate: 1.3 }],
    credits: [{ contact: { name: 'US Vendor' }, total: 130, date: '2026-09-02', allocations: [], payments: [], currencyCode: 'USD', currencyRate: 1.3 }],
  }, '2026-09-30');
  assert.equal(res.total, 900);
  assert.equal(res.byContact[0]['1-30 days'], 1000);
});

test('trial balance: parses balances debit-positive and skips summary rows', () => {
  const rows = parseTrialBalance(tbReport(LTD));
  const ap = rows.find((r) => r.name === 'Accounts Payable');
  assert.equal(ap.balance, -21973.8);
  assert.equal(rows.find((r) => r.name === 'Prepayments').balance, 10955.6);
  assert.equal(rows.length, LTD.length);
});

test('aged ledger: foreign items are valued at the month-end rate, as Xero does', () => {
  // Rebank INV-1857: $16,200 bill; Xero carries it at 0.753886 on 30 Sep 2026 = £12,212.95
  const docs = { invoices: [{ contact: { name: 'Rebank' }, total: 16200, date: '2026-08-10', dueDate: '2026-08-24', payments: [], currencyCode: 'USD', currencyRate: 1.350688 }], credits: [] };
  assert.equal(agedAt(docs, '2026-09-30', { rates: { USD: 0.753886 }, baseCurrency: 'GBP' }).total, 12212.95);
  const noRate = agedAt(docs, '2026-09-30', { baseCurrency: 'GBP' });
  assert.deepEqual(noRate.missingRates, ['USD']);
});

test('register grid: monthly opening, additions, releases and closing roll forward', () => {
  const { registerGrid } = require('../src/recon/registers');
  const reg = {
    openingDate: '2026-09-30',
    items: [
      { method: 'straight_line', start: '2026-10-01', end: '2027-09-30', monthlyRelease: 90, openingBalance: 1080 },
      { bookedPeriod: '2026-11', amount: 600, method: 'on_end_date', end: '2026-12-15' },
    ],
  };
  const g = registerGrid(reg, '2026-09', '2026-12');
  assert.deepEqual(g.months, ['2026-09', '2026-10', '2026-11', '2026-12']);
  assert.equal(g.totals.closing['2026-09'], 1080);
  assert.equal(g.totals.releases['2026-10'], -90);
  assert.equal(g.totals.additions['2026-11'], 600);
  assert.equal(g.totals.closing['2026-11'], 1500);
  assert.equal(g.totals.releases['2026-12'], -690);
  for (const m of g.months.slice(1)) {
    assert.equal(Math.round((g.totals.opening[m] + g.totals.additions[m] + g.totals.releases[m]) * 100), Math.round(g.totals.closing[m] * 100), m);
  }
});

test('sections: accounts group the way Xero lays out the balance sheet', () => {
  const { sectionFor, groupRows } = require('../src/recon/sections');
  assert.equal(sectionFor('ASSET', 'BANK'), 'bank');
  assert.equal(sectionFor('ASSET', 'PREPAYMENT'), 'current-assets');
  assert.equal(sectionFor('LIABILITY', 'TERMLIAB'), 'noncurrent-liabilities');
  const g = groupRows([
    { account: 'Revolut GBP Main', section: 'bank', xero: 100 },
    { account: 'Chase', section: 'bank', xero: 50 },
    { account: 'Prepayments', section: 'current-assets', xero: 10 },
    { account: 'Accruals', section: 'current-liabilities', xero: 5 },
  ]);
  assert.deepEqual(g.map((x) => x.label), ['Assets', 'Liabilities']);
  assert.deepEqual(g[0].sections.map((s) => [s.label, s.total, s.rows[0].account]), [['Bank', 150, 'Chase'], ['Current assets', 10, 'Prepayments']]);
  assert.equal(g[0].total, 160);
});
