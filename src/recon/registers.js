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
function itemSchedule(item, registerOpeningDate, toMonth) {
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

function loadRegisters(entityKey, registerDir = REGISTER_DIR) {
  const dir = path.join(registerDir, entityKey);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => ({ ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')), _file: path.join(dir, f) }));
}

module.exports = { itemSchedule, registerBalance, registerGrid, loadRegisters, addMonths, monthEnd, monthOf, REGISTER_DIR };
