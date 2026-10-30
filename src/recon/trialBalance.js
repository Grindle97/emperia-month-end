// Turn Xero's Trial Balance report into one row per account.
//
// Report shape: a header row (Account | Debit | Credit | YTD Debit | YTD Credit)
// then sections (Revenue, Expenses, Assets, Liabilities, Equity) of rows. For a
// balance sheet account the YTD columns carry the cumulative balance at the
// report date, which is what a reconciliation needs.
//
// Convention used everywhere in this project: balance is DEBIT-POSITIVE
// (debit minus credit). A liability with a credit balance is negative here;
// rules that present liabilities as positive numbers flip the sign themselves.

function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function lower(v) {
  return String(v || '').toLowerCase();
}

/** "Prepayments (620)" -> { name: 'Prepayments', code: '620' } */
function splitNameCode(label) {
  const m = String(label || '').match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  return m ? { name: m[1].trim(), code: m[2].trim() } : { name: String(label || '').trim(), code: null };
}

/**
 * @param {object} report - one report object from getReportTrialBalance
 * @returns {Array<{accountId: string|null, name: string, code: string|null, section: string, balance: number}>}
 */
function parseTrialBalance(report) {
  if (!report || !Array.isArray(report.rows)) throw new Error('Trial balance report is empty or malformed.');
  const out = [];
  for (const section of report.rows) {
    if (lower(section.rowType) !== 'section' || !Array.isArray(section.rows)) continue;
    for (const row of section.rows) {
      if (lower(row.rowType) !== 'row') continue; // skips SummaryRow totals
      const cells = row.cells || [];
      const label = cells[0] && cells[0].value;
      if (!label) continue;
      const attrs = (cells[0] && cells[0].attributes) || [];
      const idAttr = attrs.find((a) => lower(a.id) === 'account');
      const ytdDebit = num(cells[3] && cells[3].value);
      const ytdCredit = num(cells[4] && cells[4].value);
      const { name, code } = splitNameCode(label);
      out.push({
        accountId: idAttr ? idAttr.value : null,
        name,
        code,
        section: section.title || '',
        balance: round2(ytdDebit - ytdCredit),
      });
    }
  }
  return out;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { parseTrialBalance, splitNameCode, round2, num };
