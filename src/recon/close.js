// The month-end close for one or both Emperia entities.
//
// For every balance sheet account: the Xero balance, the supporting figure
// from its rule, the difference, a status, and where it can, a proposed
// journal. Nothing is posted. Proposed journals are listed for review; posting
// arrives in a later phase, behind approval.
//
// Data comes in through `source` (see xeroSource below) so the same engine
// runs against live Xero or against fixtures in tests.

const fs = require('fs');
const path = require('path');
const { parseTrialBalance, round2 } = require('./trialBalance');
const { registerBalance, loadRegisters, addMonths, monthEnd, REGISTER_DIR } = require('./registers');
const { agedAt } = require('./agedLedger');
const ACCOUNTS = require('../config/accounts');
const { entityByKey } = require('../config/entities');
const { sectionFor } = require('./sections');

const TOLERANCE = 0.05; // treated as agreed
const fmt = (n) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ROUNDING = 1.0; // reported as rounding, still listed

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

const STATUS = {
  RECONCILED: 'Reconciled',
  ROUNDING: 'Rounding',
  EXPLAINED: 'Explained',
  JOURNAL: 'Journal proposed',
  BREAK: 'Break',
  INPUT: 'Needs input',
  REVIEW: 'Review',
};

function statusForDiff(diff) {
  const a = Math.abs(diff);
  if (a <= TOLERANCE) return STATUS.RECONCILED;
  if (a <= ROUNDING) return STATUS.ROUNDING;
  return STATUS.BREAK;
}

function readJsonIfExists(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

/** Analyst explanations: registers/<entity>/_explanations.json, keyed by period then account. */
function findExplanation(entityKey, period, accountName, diff, registerDir) {
  const all = readJsonIfExists(path.join(registerDir, entityKey, '_explanations.json')) || {};
  const periods = Object.keys(all).filter((p) => p <= period).sort().reverse();
  for (const p of periods) {
    const e = Object.entries(all[p] || {}).find(([acc]) => norm(acc) === norm(accountName));
    if (e && Math.abs(Number(e[1].difference) - diff) <= TOLERANCE) {
      return { comment: e[1].comment, from: p, carriedForward: p !== period };
    }
  }
  return null;
}

/**
 * @param {object} args
 * @param {string} args.period - 'YYYY-MM'
 * @param {string[]} [args.entities] - ['ltd','inc']
 * @param {number} [args.usdGbp] - GBP per 1 USD at period end, for intercompany
 * @param {object} args.source - data access (see xeroSource)
 */
async function runClose({ period, entities = ['ltd', 'inc'], usdGbp, source, registerDir = REGISTER_DIR, inputDir }) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`Period must be YYYY-MM, got "${period}".`);
  const end = monthEnd(period);
  const priorEnd = monthEnd(addMonths(period, -1));
  inputDir = inputDir || path.join(registerDir, '..', 'inputs');

  const fxFile = readJsonIfExists(path.join(inputDir, 'fx', `${period}.json`));
  const rate = usdGbp || (fxFile && fxFile.USDGBP) || null;

  const results = {};
  const tbByEntity = {};

  for (const key of entities) {
    const entity = entityByKey(key);
    const cfg = ACCOUNTS[key] || {};
    const [accounts, tbNow, tbPrior] = await Promise.all([
      source.getAccounts(key),
      source.getTrialBalanceReport(key, end).then(parseTrialBalance),
      source.getTrialBalanceReport(key, priorEnd).then(parseTrialBalance),
    ]);
    tbByEntity[key] = tbNow;
    const chartById = new Map(accounts.map((a) => [a.accountID, a]));
    const chartByName = new Map(accounts.map((a) => [norm(a.name), a]));
    const priorByName = new Map(tbPrior.map((r) => [norm(r.name), r.balance]));
    const priorById = new Map(tbPrior.filter((r) => r.accountId).map((r) => [r.accountId, r.balance]));
    const registers = loadRegisters(key, registerDir);
    const registerByAccount = new Map(registers.map((r) => [norm(r.account), r]));
    const statements = readJsonIfExists(path.join(inputDir, 'statements', key, `${period}.json`)) || {};
    const rows = [];
    const journals = [];
    const warnings = [];

    const bsRows = tbNow.filter((r) => {
      const acc = chartById.get(r.accountId) || chartByName.get(norm(r.name));
      const cls = acc && String(acc._class || acc['class'] || '').toUpperCase();
      return cls ? ['ASSET', 'LIABILITY', 'EQUITY'].includes(cls) : /asset|liabilit|equity/i.test(r.section);
    });

    let bankTxns = null;
    let aged = {};
    // Month-end rates, base units per 1 foreign unit. USD/GBP comes from the
    // intercompany rate; other currencies from inputs/fx/<period>.json "rates".
    const fxRates = { ...((fxFile && fxFile.rates && fxFile.rates[key]) || {}) };
    if (rate && key === 'ltd') fxRates.USD = fxRates.USD || rate;
    if (rate && key === 'inc') fxRates.GBP = fxRates.GBP || 1 / rate;

    for (const tb of bsRows) {
      const acc = chartById.get(tb.accountId) || chartByName.get(norm(tb.name)) || {};
      if (acc.name) tb.name = acc.name;
      const cls = String(acc._class || acc['class'] || '').toUpperCase() || (/liabilit|equity/i.test(tb.section) ? 'LIABILITY' : 'ASSET');
      const creditNatured = cls === 'LIABILITY' || cls === 'EQUITY';
      const shown = round2(creditNatured ? -tb.balance : tb.balance); // positive = normal balance
      const priorBal = (tb.accountId && priorById.has(tb.accountId)) ? priorById.get(tb.accountId) : (priorByName.get(norm(tb.name)) || 0);
      const movement = round2(shown - round2(creditNatured ? -priorBal : priorBal));
      const row = {
        entity: entity.label, account: tb.name, code: tb.code, class: cls, xero: shown, movement,
        supporting: null, difference: null, status: STATUS.REVIEW, rule: 'review', comment: '', detail: null,
      };
      const type = String(acc.type || '').toUpperCase();
      const sys = String(acc.systemAccount || '').toUpperCase();
      row.type = type;
      row.section = sectionFor(cls, type);

      if (type === 'BANK') {
        row.rule = 'bank';
        if (!bankTxns) bankTxns = await source.getUnreconciledBankTransactions(key, end);
        const mine = bankTxns.filter((t) => t.bankAccount && (t.bankAccount.accountID === tb.accountId || norm(t.bankAccount.name) === norm(tb.name)));
        const stmt = Object.entries(statements).find(([n]) => norm(n) === norm(tb.name));
        row.detail = { unreconciled: mine.map((t) => ({ date: t.date, type: t.type, contact: t.contact && t.contact.name, reference: t.reference, total: t.total })) };
        const unrecNote = mine.length ? `${mine.length} unreconciled transaction(s) dated on or before ${end}.` : 'No unreconciled transactions.';
        if (stmt) {
          row.supporting = round2(Number(stmt[1]));
          row.difference = round2(shown - row.supporting);
          row.status = statusForDiff(row.difference);
          if (row.status === STATUS.RECONCILED && mine.length) row.status = STATUS.BREAK;
          row.comment = `Statement balance entered. ${unrecNote}`;
        } else {
          row.status = STATUS.INPUT;
          row.comment = `Statement balance at ${end} not entered yet. ${unrecNote}`;
        }
      } else if (sys === 'DEBTORS' || sys === 'CREDITORS') {
        const docType = sys === 'DEBTORS' ? 'ACCREC' : 'ACCPAY';
        row.rule = docType === 'ACCREC' ? 'aged receivables' : 'aged payables';
        try {
          if (!aged[docType]) aged[docType] = agedAt(await source.getAgedDocuments(key, docType, end), end, { rates: fxRates, baseCurrency: entity.currency });
          row.supporting = aged[docType].total;
          row.difference = round2(shown - row.supporting);
          row.status = statusForDiff(row.difference);
          row.detail = aged[docType];
          row.comment = `Rebuilt aged list at ${end} from ${aged[docType].lines.length} open document(s), foreign currency at month-end rates.`;
          if (aged[docType].missingRates.length) {
            row.comment += ` No month-end rate for ${aged[docType].missingRates.join(', ')}: those items use their document rate, so a difference is expected. Add them to inputs/fx/${period}.json.`;
          }
        } catch (err) {
          row.status = STATUS.INPUT;
          row.comment = `Could not rebuild the aged list: ${err.message}`;
        }
      } else if (cfg.intercompany && norm(tb.name) === norm(cfg.intercompany)) {
        row.rule = 'intercompany';
        row.comment = 'See intercompany check.';
        row.status = STATUS.REVIEW; // settled after both entities are read
      } else if (registerByAccount.has(norm(tb.name))) {
        const reg = registerByAccount.get(norm(tb.name));
        const { total, lines } = registerBalance(reg, period);
        row.rule = `register: ${reg.register}`;
        row.supporting = total;
        row.difference = round2(shown - total);
        row.status = statusForDiff(row.difference);
        row.detail = { register: reg.register, lines: lines.map((l) => ({ ...l.item, balance: l.balance, releasedThisMonth: l.releasedThisMonth })), notes: reg.notes || [] };
        const released = round2(lines.reduce((s, l) => s + l.releasedThisMonth, 0));
        if (row.status === STATUS.BREAK && released !== 0 && Math.abs(row.difference - released) <= ROUNDING) {
          // Xero still holds this month's releases: propose them.
          row.status = STATUS.JOURNAL;
          row.comment = `This month's releases (${fmt(released)}) are not yet posted in Xero.`;
          journals.push(releaseJournal(entity, reg, lines, period, end));
        } else if (released !== 0) {
          row.comment = `Includes ${fmt(released)} released this month.`;
        }
        if (reg.notes && reg.notes.length) row.comment = [row.comment, ...reg.notes].filter(Boolean).join(' ');
      } else if (cfg.reviewNotes && Object.keys(cfg.reviewNotes).some((n) => norm(n) === norm(tb.name))) {
        row.rule = 'review';
        row.comment = Object.entries(cfg.reviewNotes).find(([n]) => norm(n) === norm(tb.name))[1];
      } else if (cls === 'EQUITY' && /earnings/i.test(tb.name)) {
        row.rule = 'equity';
        row.status = STATUS.RECONCILED;
        row.comment = 'Result of the P&L; no reconciliation needed.';
      } else {
        row.comment = 'No rule or register yet for this account.';
      }

      if ((row.status === STATUS.BREAK || row.status === STATUS.ROUNDING) && row.difference !== null) {
        const ex = findExplanation(key, period, tb.name, row.difference, registerDir);
        if (ex) {
          row.status = STATUS.EXPLAINED;
          row.comment = [ex.comment, ex.carriedForward ? `(explanation carried forward from ${ex.from}; confirm)` : '', row.comment].filter(Boolean).join(' ');
        }
      }
      rows.push(row);
    }

    // Registers whose account is missing from the trial balance (zero or renamed).
    for (const reg of registers) {
      if (!rows.some((r) => norm(r.account) === norm(reg.account))) {
        const { total } = registerBalance(reg, period);
        if (Math.abs(total) > TOLERANCE) {
          warnings.push(`Register "${reg.register}" expects ${fmt(total)} on "${reg.account}", which is not on the trial balance.`);
        }
      }
    }

    results[key] = { entity, period, end, rows, journals, warnings };
  }

  // Intercompany: Inc's USD balance is the reference; Ltd carries it in GBP.
  if (results.ltd && results.inc) {
    const ic = intercompanyCheck(results, tbByEntity, rate);
    results.intercompany = ic;
  }
  return results;
}

function releaseJournal(entity, reg, lines, period, end) {
  const isAsset = reg.side === 'asset';
  const items = lines.filter((l) => l.releasedThisMonth !== 0);
  const jl = [];
  for (const l of items) {
    const amt = round2(l.releasedThisMonth);
    const other = l.item.expenseAccount || l.item.revenueAccount || '(account to confirm)';
    const label = [l.item.supplier || l.item.customer || l.item.description, l.item.invoiceNumber].filter(Boolean).join(' ');
    // Prepayment release: Dr expense / Cr prepayments. Deferred revenue release: Dr deferred / Cr revenue.
    if (isAsset) {
      jl.push({ account: other, debit: amt, credit: 0, description: `Release ${label}` });
    } else {
      jl.push({ account: other, debit: 0, credit: amt, description: `Release ${label}` });
    }
  }
  const totalRel = round2(items.reduce((s, l) => s + l.releasedThisMonth, 0));
  jl.push(isAsset
    ? { account: reg.account, debit: 0, credit: totalRel, description: `${reg.register} releases ${period}` }
    : { account: reg.account, debit: totalRel, credit: 0, description: `${reg.register} releases ${period}` });
  return {
    entity: entity.label, date: end, narration: `${reg.register} releases for ${period}`,
    reason: `Register ${reg.register}: monthly releases not yet in Xero.`, lines: jl,
  };
}

function intercompanyCheck(results, tbByEntity, rate) {
  const ltdName = ACCOUNTS.ltd.intercompany;
  const incName = ACCOUNTS.inc.intercompany;
  const ltdRow = results.ltd.rows.find((r) => norm(r.account) === norm(ltdName));
  const incRow = results.inc.rows.find((r) => norm(r.account) === norm(incName));
  const out = { ltdAccount: ltdName, incAccount: incName, rate, status: STATUS.REVIEW, comment: '', journal: null };
  if (!ltdRow || !incRow) {
    out.status = STATUS.INPUT;
    out.comment = `Intercompany account not found on ${!ltdRow ? 'Ltd' : 'Inc'} trial balance.`;
    return out;
  }
  // Ltd: asset in GBP (debit). Inc: liability in USD (credit). Both shown positive when normal.
  const ltdGbp = ltdRow.class === 'ASSET' ? ltdRow.xero : -ltdRow.xero;
  const incUsd = incRow.class === 'LIABILITY' ? incRow.xero : -incRow.xero;
  out.ltdGbp = ltdGbp;
  out.incUsd = incUsd;
  incRow.status = STATUS.RECONCILED;
  incRow.supporting = incUsd;
  incRow.difference = 0;
  incRow.comment = 'USD reference balance for intercompany. Unmatched items: compare both ledgers (phase 1: manual).';
  if (!rate) {
    out.status = STATUS.INPUT;
    out.comment = `Enter the ${results.ltd.end} USD/GBP rate (--usd-gbp or inputs/fx/${results.ltd.period}.json).`;
    ltdRow.status = STATUS.INPUT;
    ltdRow.comment = out.comment;
    return out;
  }
  const expected = round2(incUsd * rate);
  const diff = round2(expected - ltdGbp);
  out.expectedGbp = expected;
  out.difference = diff;
  ltdRow.supporting = expected;
  ltdRow.difference = round2(ltdRow.xero - (ltdRow.class === 'ASSET' ? expected : -expected));
  if (Math.abs(diff) <= TOLERANCE) {
    out.status = ltdRow.status = STATUS.RECONCILED;
    out.comment = ltdRow.comment = `Inc owes $${fmt(incUsd)} = £${fmt(expected)} at ${rate}. Agrees.`;
    return out;
  }
  out.status = ltdRow.status = STATUS.JOURNAL;
  out.comment = ltdRow.comment = `Inc owes $${fmt(incUsd)} = £${fmt(expected)} at ${rate}; Xero holds £${fmt(ltdGbp)}. Revaluation of £${fmt(Math.abs(diff))} not posted.`;
  const amt = Math.abs(diff);
  const gain = diff > 0;
  out.journal = {
    entity: results.ltd.entity.label, date: results.ltd.end,
    narration: `Intercompany revaluation at ${rate} USD/GBP, ${results.ltd.period}`,
    reason: out.comment,
    lines: [
      { account: ltdName, debit: gain ? amt : 0, credit: gain ? 0 : amt, description: 'Revalue intercompany balance to month-end rate' },
      { account: ACCOUNTS.ltd.fxRevaluation, debit: gain ? 0 : amt, credit: gain ? amt : 0, description: `Unrealised FX ${gain ? 'gain' : 'loss'} on intercompany` },
    ],
  };
  results.ltd.journals.push(out.journal);
  return out;
}

/** Live Xero source. */
function xeroSource() {
  const data = require('../xero/data');
  return {
    getAccounts: data.getAccounts,
    getTrialBalanceReport: data.getTrialBalanceReport,
    getUnreconciledBankTransactions: data.getUnreconciledBankTransactions,
    async getAgedDocuments(key, docType, end) {
      const invoices = await data.getInvoicesUpTo(key, docType, end);
      const credits = [];
      const cnType = docType === 'ACCREC' ? 'ACCRECCREDIT' : 'ACCPAYCREDIT';
      const tag = (arr, kind) => arr.map((x) => ({ ...x, _kind: kind }));
      credits.push(...tag(await data.getCreditNotesUpTo(key, cnType, end), 'credit note'));
      for (const kind of ['overpayment', 'prepayment']) {
        try {
          credits.push(...tag(await data.getUnappliedPaymentsUpTo(key, kind, docType, end), kind));
        } catch (err) {
          if (err.status !== 403) throw err; // missing scope: carry on, difference will show
        }
      }
      return { invoices, credits };
    },
  };
}

module.exports = { runClose, xeroSource, STATUS, TOLERANCE };
