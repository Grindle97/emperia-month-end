// Aged receivables / payables AS AT a past month end, rebuilt from documents.
//
// Xero's aged reports are per contact over the API, and "amount due" on an
// invoice is as of today. A close runs some days after month end, by which
// time bills have been paid, so today's amount due is the wrong number. This
// rebuilds each document's balance at the month end: total, less payments,
// credit notes and pre/overpayments applied on or before that date.
//
// Credit note allocations on an invoice carry no allocation date in every
// API version, so an allocation is treated as made on the credit note's own
// date. Where that is wrong the difference shows up against the ledger and
// is reported, not hidden.
//
// Foreign-currency balances are converted at the MONTH-END rate, because that
// is how Xero's balance sheet and aged reports value open foreign items (it
// revalues them on the fly). `rates` maps currency -> base units per 1 foreign
// unit. A currency with no month-end rate falls back to the document's own
// rate (Xero's CurrencyRate = foreign units per 1 base unit) and is reported.

const { round2 } = require('./trialBalance');

/** Xero dates arrive as '/Date(1727654400000+0000)/', ISO strings or Date objects. */
function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const ms = s.match(/\/Date\((-?\d+)/);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

const onOrBefore = (v, end) => {
  const d = toIsoDate(v);
  return d !== null && d <= end;
};
const sum = (arr, f) => (arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0);
const docRate = (amount, rate) => (Number(rate) > 0 ? amount / Number(rate) : amount);
function toBase(amount, doc, rates, baseCurrency, missing) {
  const ccy = doc.currencyCode;
  if (!ccy || ccy === baseCurrency) return amount;
  if (rates && Number(rates[ccy]) > 0) return amount * Number(rates[ccy]);
  if (missing) missing.add(ccy);
  return docRate(amount, doc.currencyRate);
}

/** Outstanding on an invoice/bill at `end`, in document currency. */
function invoiceOutstandingAt(inv, end) {
  const total = Number(inv.total) || 0;
  const paid = sum((inv.payments || []).filter((p) => onOrBefore(p.date, end)), (p) => p.amount);
  const credited = sum((inv.creditNotes || []).filter((c) => !c.date || onOrBefore(c.date, end)), (c) => c.appliedAmount);
  const prepaid = sum(inv.prepayments, (p) => p.appliedAmount) + sum(inv.overpayments, (p) => p.appliedAmount);
  return round2(total - paid - credited - prepaid);
}

/** Unapplied balance of a credit note / overpayment / prepayment at `end`. */
function creditRemainingAt(doc, end) {
  const total = Number(doc.total) || 0;
  const allocated = sum((doc.allocations || []).filter((a) => !a.date || onOrBefore(a.date, end)), (a) => a.amount);
  const refunded = sum((doc.payments || []).filter((p) => onOrBefore(p.date, end)), (p) => p.amount);
  return round2(total - allocated - refunded);
}

function ageBucket(dueIso, end) {
  if (!dueIso) return 'Current';
  const days = Math.floor((Date.parse(end) - Date.parse(dueIso)) / 86400000);
  if (days <= 0) return 'Current';
  if (days <= 30) return '1-30 days';
  if (days <= 60) return '31-60 days';
  if (days <= 90) return '61-90 days';
  return 'Older';
}

const BUCKETS = ['Current', '1-30 days', '31-60 days', '61-90 days', 'Older'];

/**
 * @param {{invoices: object[], credits: object[]}} docs - invoices of one type,
 *   and the credit notes / overpayments / prepayments on the same side
 * @param {string} end - 'YYYY-MM-DD'
 * @returns {{total: number, lines: object[], byContact: object[]}}
 *   amounts in base currency, positive = owed (to us for AR, by us for AP)
 */
function agedAt(docs, end, { rates = {}, baseCurrency } = {}) {
  const lines = [];
  const missing = new Set();
  for (const inv of docs.invoices || []) {
    if (!onOrBefore(inv.date, end)) continue;
    const out = invoiceOutstandingAt(inv, end);
    if (Math.abs(out) < 0.005) continue;
    lines.push({
      contact: inv.contact && inv.contact.name,
      number: inv.invoiceNumber || inv.reference || '',
      date: toIsoDate(inv.date),
      due: toIsoDate(inv.dueDate),
      currency: inv.currencyCode,
      outstanding: out,
      base: round2(toBase(out, inv, rates, baseCurrency, missing)),
      bucket: ageBucket(toIsoDate(inv.dueDate), end),
      kind: 'invoice',
    });
  }
  for (const c of docs.credits || []) {
    if (!onOrBefore(c.date, end)) continue;
    const rem = creditRemainingAt(c, end);
    if (Math.abs(rem) < 0.005) continue;
    lines.push({
      contact: c.contact && c.contact.name,
      number: c.creditNoteNumber || c.reference || c._kind || 'credit',
      date: toIsoDate(c.date),
      due: null,
      currency: c.currencyCode,
      outstanding: -rem,
      base: round2(-toBase(rem, c, rates, baseCurrency, missing)),
      bucket: 'Older',
      kind: c._kind || 'credit note',
    });
  }
  const contacts = new Map();
  for (const l of lines) {
    const key = l.contact || '(no contact)';
    if (!contacts.has(key)) contacts.set(key, Object.fromEntries([['contact', key], ...BUCKETS.map((b) => [b, 0]), ['total', 0]]));
    const row = contacts.get(key);
    row[l.bucket] = round2(row[l.bucket] + l.base);
    row.total = round2(row.total + l.base);
  }
  const byContact = [...contacts.values()].sort((a, b) => a.contact.localeCompare(b.contact));
  return { total: round2(sum(lines, (l) => l.base)), lines, byContact, missingRates: [...missing] };
}

module.exports = { agedAt, invoiceOutstandingAt, creditRemainingAt, toIsoDate, ageBucket, BUCKETS };
