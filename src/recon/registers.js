// Registers: the agent's own copy of each supporting schedule (prepayments,
// accruals, deposits, deferred revenue...). Each one lives as JSON under
// registers/<entity>/<name>.json.
//
// A register is not rolled forward by hand. It holds each item's balance at
// the register's opening date plus the rule for releasing it, and the expected
// balance at any later month end is computed from that. This is what removes
// the copy-forward formula errors the workbooks suffer from.
//
// Item methods:
//   static        - balance stays as is until someone changes or closes it
//                   (accruals, deposits, loan balances)
//   straight_line - released by `monthlyRelease` each month from the start
//                   month; whatever is left goes in the end month
//   on_end_date   - released in full in the month of `end` (events, trips)
//
// Item timing:
//   seeded items (from the opening schedules) release from the month AFTER
//   the register's opening date.
//   items added later carry `bookedPeriod` ('YYYY-MM'): they count from that
//   month and can release in it, matching how the workbooks treat a
//   prepayment booked and starting in the same month.
//   `closedPeriod` ('YYYY-MM') removes an item from that month on (an accrual
//   reversed when the bill arrives, a deposit refunded).

const fs = require('fs');
const path = require('path');
const { round2 } = require('./trialBalance');

const REGISTER_DIR = process.env.REGISTER_DIR || path.join(__dirname, '..', '..', 'registers');

const monthOf = (isoDate) => String(isoDate).slice(0, 7);

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Month-by-month schedule for one item, from its first month up to `toMonth`.
 * @returns {{balance: number, releases: Object<string, number>}} balance at the
 *   end of toMonth, and the amount released in each month along the way.
 */
/** Balance of a held item built from dated entries ('b/f' = brought forward). */
function entriesBalance(item, month) {
  return round2((item.entries || []).reduce((t, e) => (e.period === 'b/f' || e.period <= month ? t + Number(e.amount || 0) : t), 0));
}

function itemSchedule(item, registerOpeningDate, toMonth) {
  // Held items with their own history (accruals, deposits, loans): the balance
  // is the sum of dated entries, until the item is closed.
  if (item.method === 'static' && Array.isArray(item.entries) && item.entries.length) {
    const releases = {};
    if (item.closedPeriod && toMonth >= item.closedPeriod) {
      const before = entriesBalance(item, addMonths(item.closedPeriod, -1));
      if (before !== 0) releases[item.closedPeriod] = before;
      return { balance: 0, releases };
    }
    return { balance: entriesBalance(item, toMonth), releases };
  }
  const seeded = !item.bookedPeriod;
  const firstMonth = seeded ? addMonths(monthOf(registerOpeningDate), 1) : item.bookedPeriod;
  const releases = {};

  if (!seeded && toMonth < item.bookedPeriod) return { balance: 0, releases };
  if (seeded && toMonth < monthOf(registerOpeningDate)) {
    throw new Error(`Register opens ${registerOpeningDate}; cannot compute ${toMonth}.`);
  }

  let bal = Number(seeded ? item.openingBalance : (item.amount ?? item.openingBalance)) || 0;

  for (let m = firstMonth; m <= toMonth; m = addMonths(m, 1)) {
    if (item.closedPeriod && m >= item.closedPeriod) {
      if (bal !== 0) releases[m] = round2((releases[m] || 0) + bal);
      bal = 0;
      break;
    }
    if (bal === 0) continue;
    let rel = 0;
    if (item.method === 'on_end_date') {
      if (m >= monthOf(item.end)) rel = bal;
    } else if (item.method === 'straight_line') {
      const startM = item.start ? monthOf(item.start) : firstMonth;
      const endM = item.end ? monthOf(item.end) : null;
      if (m >= startM) {
        if (endM && m >= endM) rel = bal;
        else {
          const step = Math.abs(Number(item.monthlyRelease) || 0);
          rel = Math.sign(bal) * Math.min(step, Math.abs(bal));
        }
      }
    } // static: no movement
    rel = round2(rel);
    if (rel !== 0) {
      releases[m] = rel;
      bal = round2(bal - rel);
    }
  }
  return { balance: round2(bal), releases };
}

/** Expected register balance at the end of `month`, with per-item detail. */
function registerBalance(register, month) {
  const lines = (register.items || []).map((item) => {
    const { balance, releases } = itemSchedule(item, register.openingDate, month);
    return { item, balance, releasedThisMonth: releases[month] || 0 };
  });
  return { total: round2(lines.reduce((s, l) => s + l.balance, 0)), lines };
}

/**
 * Month-by-month view of a register, like the workbook tabs: one row per item,
 * one column per month. The first column is the register's opening month
 * (balances brought forward); later columns show additions (items booked that
 * month) and releases.
 * @returns {{months: string[], items: object[], totals: {opening, additions, releases, closing}}}
 *   releases are shown as negative movements for both assets and liabilities.
 */
function registerGrid(register, fromMonth, toMonth) {
  const openMonth = monthOf(register.openingDate);
  const start = fromMonth < openMonth ? openMonth : fromMonth;
  const months = [];
  for (let m = start; m <= toMonth; m = addMonths(m, 1)) months.push(m);
  const totals = { opening: {}, additions: {}, releases: {}, closing: {} };
  months.forEach((m) => { for (const k of Object.keys(totals)) totals[k][m] = 0; });

  const items = (register.items || []).map((item) => {
    const { releases } = itemSchedule(item, register.openingDate, toMonth);
    const cells = {};
    const balances = {};
    for (const m of months) {
      const before = m === openMonth ? 0 : itemSchedule(item, register.openingDate, addMonths(m, -1)).balance;
      const after = itemSchedule(item, register.openingDate, m).balance;
      const added = m === openMonth
        ? (item.bookedPeriod ? 0 : after) // brought forward
        : (item.bookedPeriod === m ? round2(Number(item.amount ?? item.openingBalance) || 0) : 0);
      const released = -(releases[m] || 0);
      cells[m] = { added, released };
      balances[m] = after;
      totals.opening[m] = round2(totals.opening[m] + before);
      totals.additions[m] = round2(totals.additions[m] + added);
      totals.releases[m] = round2(totals.releases[m] + released);
      totals.closing[m] = round2(totals.closing[m] + after);
    }
    return { item, cells, balances, live: Object.values(balances).some((b) => b !== 0) };
  });
  return { months, openMonth, items, totals };
}

/**
 * Historic view for held registers (accruals, deposits, loans, tax): each item
 * shows what was booked in the month it relates to, and the balance at the
 * close month sits on the far right. Only months with activity get a column.
 */
function historicGrid(register, period) {
  const months = new Set();
  let hasBf = false;
  const rows = (register.items || []).map((item) => {
    const cells = {};
    let bf = 0;
    for (const e of item.entries || []) {
      if (e.period === 'b/f') { bf = round2(bf + Number(e.amount || 0)); hasBf = true; continue; }
      if (e.period > period) continue;
      cells[e.period] = round2((cells[e.period] || 0) + Number(e.amount || 0));
      months.add(e.period);
    }
    if (!item.entries || !item.entries.length) { bf = round2(Number(item.openingBalance) || 0); if (bf) hasBf = true; }
    if (item.closedPeriod && item.closedPeriod <= period) {
      const before = item.entries && item.entries.length ? entriesBalance(item, addMonths(item.closedPeriod, -1)) : Number(item.openingBalance) || 0;
      if (before) { cells[item.closedPeriod] = round2((cells[item.closedPeriod] || 0) - before); months.add(item.closedPeriod); }
    }
    const balance = itemSchedule(item, register.openingDate, period).balance;
    const recent = Object.keys(cells).some((m) => m > addMonths(period, -12));
    return { item, bf, cells, balance, show: balance !== 0 || recent || (register.items || []).length <= 8 };
  });
  const cols = [...months].sort();
  const totals = Object.fromEntries(cols.map((m) => [m, round2(rows.reduce((t, r) => t + (r.cells[m] || 0), 0))]));
  return {
    view: 'historic',
    months: cols,
    hasBf,
    bfTotal: round2(rows.reduce((t, r) => t + r.bf, 0)),
    items: rows.filter((r) => r.show),
    hiddenCount: rows.filter((r) => !r.show).length,
    totals,
    balance: round2(rows.reduce((t, r) => t + r.balance, 0)),
  };
}

function loadRegisters(entityKey, registerDir = REGISTER_DIR) {
  const dir = path.join(registerDir, entityKey);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => ({ ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')), _file: path.join(dir, f) }));
}

module.exports = { itemSchedule, registerBalance, registerGrid, historicGrid, entriesBalance, loadRegisters, addMonths, monthEnd, monthOf, REGISTER_DIR };
