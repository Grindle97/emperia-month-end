// September 2026 Xero balances for both entities, as recorded in the analyst's
// Sep 2026 reconciliation workbooks (Ltd: BS Review; Inc: Xero BS tab).
// Used to prove the engine reproduces the analyst's findings before it ever
// touches live Xero.

// [name, class, type, systemAccount, shownBalance] — shownBalance positive = normal side
const LTD = [
  ['Computer Equipment', 'ASSET', 'FIXED', null, 21441.37],
  ['Investment in US Subsidiary', 'ASSET', 'FIXED', null, 0.79],
  ['Less Accumulated Depreciation on Computer Equipment', 'ASSET', 'FIXED', null, -18809.0],
  ['Flagstone Holding Account', 'ASSET', 'BANK', null, 123.84],
  ['Revolut EUR Main', 'ASSET', 'BANK', null, 1809.44],
  ['Revolut GBP Main', 'ASSET', 'BANK', null, 8817.08],
  ['Revolut USD Main', 'ASSET', 'BANK', null, 65165.03],
  ['Transferwise GBP Account', 'ASSET', 'BANK', null, 0.21],
  ['Transferwise USD Account', 'ASSET', 'BANK', null, 5.77],
  ['Accounts Receivable', 'ASSET', 'CURRENT', 'DEBTORS', 0],
  ['Deposits', 'ASSET', 'CURRENT', null, 5000.0],
  ['Intercompany - Emperia VR Inc', 'ASSET', 'CURRENT', null, 2008518.66],
  ['Other debtors', 'ASSET', 'CURRENT', null, 2090.0],
  ['Overseas worker employment deposit', 'ASSET', 'CURRENT', null, 42342.33],
  ['Prepayments', 'ASSET', 'CURRENT', null, 10955.6],
  ['Accounts Payable', 'LIABILITY', 'CURRLIAB', 'CREDITORS', 21973.8],
  ['Accruals', 'LIABILITY', 'CURRLIAB', null, 12531.46],
  ["Directors' Loan Account", 'LIABILITY', 'CURRLIAB', null, 80.43],
  ['Income in Advance', 'LIABILITY', 'CURRLIAB', null, 0],
  ['PAYE Payable', 'LIABILITY', 'CURRLIAB', null, 5681.26],
  ['Pensions Payable', 'LIABILITY', 'CURRLIAB', null, 587.04],
  ['Provision for Corporation Tax', 'LIABILITY', 'CURRLIAB', null, -83425.27],
  ['VAT', 'LIABILITY', 'CURRLIAB', 'GST', -2079.56],
  ['Capital - Series A Preferred Shares', 'EQUITY', 'EQUITY', null, 1.07],
  ['Capital - x,xxx Ordinary Shares', 'EQUITY', 'EQUITY', null, 2.89],
  ['Retained Earnings', 'EQUITY', 'EQUITY', 'RETAINEDEARNINGS', -6349319.66],
  ['Share Premium Account', 'EQUITY', 'EQUITY', null, 8969930.23],
];

const INC = [
  ['Brex business account (Primary checking)', 'ASSET', 'BANK', null, 26.0],
  ['Brex business account#002 (Treasury)', 'ASSET', 'BANK', null, 2440269.39],
  ['Business Platinum Card®', 'ASSET', 'BANK', null, 18088.53],
  ['Chase USD Main', 'ASSET', 'BANK', null, 347316.61],
  ['Accrued Income', 'ASSET', 'CURRENT', null, 180150.71],
  ['Deposits', 'ASSET', 'CURRENT', null, 2765.45],
  ['Prepayments', 'ASSET', 'CURRENT', null, 16930.0],
  ['Legal Fees for Incorporation', 'ASSET', 'FIXED', null, 18902.5],
  ['Less Accumulated Depreciation on Legal Fees for Incorporation', 'ASSET', 'FIXED', null, -4725.45],
  ["Directors' Loan Account", 'LIABILITY', 'CURRLIAB', null, -84987.0],
  ['Income in Advance', 'LIABILITY', 'CURRLIAB', null, 13749.83],
  ['Intercompany - Emperia Ltd', 'LIABILITY', 'CURRLIAB', null, 2704772.24],
  ['Provision for Corporation Tax', 'LIABILITY', 'CURRLIAB', null, -11440.0],
  ['Provision for State Tax', 'LIABILITY', 'CURRLIAB', null, 783.0],
  ['Capital - x,xxx Ordinary Shares', 'EQUITY', 'EQUITY', null, 1.0],
  ['Retained Earnings', 'EQUITY', 'EQUITY', 'RETAINEDEARNINGS', 123330.14],
];

const SECTION = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity' };

function tbReport(rows, overrides = {}) {
  const sections = {};
  rows.forEach(([name, cls, , , shown], i) => {
    const value = overrides[name] !== undefined ? overrides[name] : shown;
    const debitPositive = cls === 'ASSET' ? value : -value;
    const sec = SECTION[cls];
    sections[sec] = sections[sec] || [];
    sections[sec].push({
      rowType: 'Row',
      cells: [
        { value: `${name} (${100 + i})`, attributes: [{ id: 'account', value: `acc-${name}` }] },
        { value: '' }, { value: '' },
        { value: debitPositive > 0 ? debitPositive.toFixed(2) : '' },
        { value: debitPositive < 0 ? (-debitPositive).toFixed(2) : '' },
      ],
    });
  });
  return {
    rows: [
      { rowType: 'Header', cells: [{ value: 'Account' }, { value: 'Debit' }, { value: 'Credit' }, { value: 'YTD Debit' }, { value: 'YTD Credit' }] },
      ...Object.entries(sections).map(([title, r]) => ({ rowType: 'Section', title, rows: [...r, { rowType: 'SummaryRow', cells: [{ value: 'Total' }] }] })),
    ],
  };
}

function chart(rows) {
  return rows.map(([name, cls, type, sys]) => ({ accountID: `acc-${name}`, name, _class: cls, type, systemAccount: sys || undefined }));
}

/** A source with fixed TBs per entity and period end; aged docs supplied per test. */
function fixtureSource({ tb = {}, aged = {}, bank = {} } = {}) {
  const base = { ltd: LTD, inc: INC };
  return {
    async getAccounts(key) { return chart(base[key]); },
    async getTrialBalanceReport(key, date) { return tbReport(base[key], (tb[key] && tb[key][date]) || {}); },
    async getUnreconciledBankTransactions(key) { return bank[key] || []; },
    async getAgedDocuments(key, type) { return (aged[key] && aged[key][type]) || { invoices: [], credits: [] }; },
  };
}

// Ltd aged payables at 30 Sep 2026, per the analyst's Trade creditors tab.
const bill = (contact, total, date = '2026-09-15', due = '2026-10-15') =>
  ({ contact: { name: contact }, total, date, dueDate: due, payments: [], currencyCode: 'GBP', currencyRate: 1 });
const LTD_AP = {
  invoices: [
    bill('Amazon Web Services', 1940.51), bill('F. INITIATIVES LIMITED', 4158.0), bill('Google', 308.59),
    bill('Rebank Technologies Limited', 12212.96, '2026-08-10', '2026-08-20'),
    bill('RORA - Quantico Analytics Limited', 4380.0), bill('Sohoworks', 330.0, '2026-05-01', '2026-06-01'),
    bill('Unconditionally Human Ltd', 360.0),
  ],
  credits: [{ contact: { name: 'Ahmad Sarfraz' }, total: 1716.26, date: '2025-01-10', allocations: [], payments: [], _kind: 'overpayment' }],
};

/** The September demo: workbook balances plus the Ltd AP list. */
const demoSource = () => fixtureSource({ aged: { ltd: { ACCPAY: LTD_AP } } });

module.exports = { LTD, INC, LTD_AP, tbReport, chart, fixtureSource, demoSource };
