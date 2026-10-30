// Writes one reconciliation pack per entity: the same shape as the analyst's
// workbook (account, Xero balance, supporting balance, difference, status,
// comment), plus the detail behind each rule and the proposed journals.

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { groupRows, sectionFor } = require('../recon/sections');
const { registerGrid, loadRegisters, addMonths, REGISTER_DIR } = require('../recon/registers');

const MONEY = '#,##0.00;[Red]-#,##0.00';
const STATUS_FILL = {
  Reconciled: 'FFE2F0D9',
  Rounding: 'FFE2F0D9',
  Explained: 'FFFFF2CC',
  'Journal proposed': 'FFDDEBF7',
  Break: 'FFF8CBAD',
  'Needs input': 'FFFCE4D6',
  Review: 'FFEDEDED',
};

function header(ws, cols) {
  ws.columns = cols.map((c) => ({ header: c.h, key: c.k, width: c.w || 16, style: c.money ? { numFmt: MONEY } : {} }));
  const r = ws.getRow(1);
  r.font = { bold: true };
  r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

async function writeEntityPack(result, intercompany, outDir, { registerDir = REGISTER_DIR } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Emperia close agent';
  const { entity, period, end, rows, journals, warnings } = result;

  // Summary
  const s = wb.addWorksheet('BS Review');
  header(s, [
    { h: 'Account', k: 'account', w: 46 }, { h: 'Code', k: 'code', w: 8 },
    { h: `Xero ${end}`, k: 'xero', money: true }, { h: 'Supporting', k: 'supporting', money: true },
    { h: 'Difference', k: 'difference', money: true }, { h: 'Status', k: 'status', w: 16 },
    { h: 'Movement in month', k: 'movement', money: true }, { h: 'Rule', k: 'rule', w: 24 },
    { h: 'Comment', k: 'comment', w: 90 },
  ]);
  // Same layout as Xero's balance sheet: class, then section, with subtotals.
  const withSection = rows.map((r) => ({ ...r, section: r.section || sectionFor(r.class, r.type) }));
  for (const g of groupRows(withSection)) {
    s.addRow({ account: g.label }).font = { bold: true, size: 12 };
    for (const sec of g.sections) {
      s.addRow({ account: `  ${sec.label}` }).font = { bold: true };
      for (const r of sec.rows) {
        const row = s.addRow({ ...r, account: `    ${r.account}` });
        const fill = STATUS_FILL[r.status];
        if (fill) row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        row.getCell('comment').alignment = { wrapText: true, vertical: 'top' };
      }
      if (sec.rows.length > 1) {
        const t = s.addRow({ account: `  Total ${sec.label.toLowerCase()}`, xero: sec.total });
        t.font = { bold: true };
        t.getCell('xero').border = { top: { style: 'thin' } };
      }
    }
    const t = s.addRow({ account: `Total ${g.label.toLowerCase()}`, xero: g.total });
    t.font = { bold: true };
    t.getCell('xero').border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    s.addRow({});
  }
  if (warnings.length) {
    s.addRow({});
    s.addRow({ account: 'Warnings' }).font = { bold: true };
    warnings.forEach((w) => s.addRow({ account: w }));
  }

  // Proposed journals
  const j = wb.addWorksheet('Proposed journals');
  header(j, [
    { h: '#', k: 'n', w: 5 }, { h: 'Date', k: 'date', w: 12 }, { h: 'Narration', k: 'narration', w: 46 },
    { h: 'Account', k: 'account', w: 40 }, { h: 'Debit', k: 'debit', money: true }, { h: 'Credit', k: 'credit', money: true },
    { h: 'Line description', k: 'description', w: 50 }, { h: 'Why', k: 'reason', w: 70 },
  ]);
  if (!journals.length) j.addRow({ narration: 'No journals proposed.' });
  journals.forEach((jn, i) => {
    jn.lines.forEach((l, k) => j.addRow({ n: i + 1, date: jn.date, narration: k === 0 ? jn.narration : '', ...l, reason: k === 0 ? jn.reason : '' }));
    j.addRow({});
  });
  j.addRow({ narration: 'Not posted. Each journal needs approval before it reaches Xero.' }).font = { italic: true };

  // Registers, month by month like the workbook tabs: items down, months across.
  const registers = loadRegisters(entity.key, registerDir);
  for (const r of rows.filter((x) => x.detail && x.detail.register)) {
    const reg = registers.find((x) => x.register === r.detail.register);
    if (!reg) continue;
    const grid = registerGrid(reg, addMonths(period, -11), addMonths(period, 6));
    const title = reg.register.replace(/-/g, ' ').replace(/^eor /, 'EOR ').replace(/^./, (c) => c.toUpperCase());
    const ws = wb.addWorksheet(title.slice(0, 31));
    const mcols = grid.months.map((m) => ({ h: m === grid.openMonth ? `b/f ${monthLabel(m)}` : monthLabel(m), k: m, money: true, w: 13 }));
    header(ws, [
      { h: 'Supplier / customer / description', k: 'who', w: 40 }, { h: 'Invoice', k: 'invoiceNumber', w: 16 },
      { h: 'Account', k: 'acct', w: 30 }, { h: 'Start', k: 'start', w: 11 }, { h: 'End', k: 'end', w: 11 }, ...mcols,
    ]);
    const curCol = 6 + grid.months.indexOf(period);
    for (const x of grid.items.filter((i) => i.live)) {
      const it = x.item;
      const vals = Object.fromEntries(grid.months.map((m) => {
        const c = x.cells[m];
        const v = m === grid.openMonth ? c.added : (c.added || 0) + (c.released || 0);
        return [m, v || null];
      }));
      ws.addRow({ who: [it.supplier, it.customer, it.description].filter(Boolean)[0], invoiceNumber: it.invoiceNumber, acct: it.expenseAccount || it.revenueAccount || '', start: it.start, end: it.end, ...vals });
    }
    ws.addRow({});
    for (const [label, k] of [['Opening balance', 'opening'], ['Added', 'additions'], ['Released', 'releases'], ['Closing balance', 'closing']]) {
      const row = ws.addRow({ who: label, ...Object.fromEntries(grid.months.map((m) => [m, (m === grid.openMonth && k !== 'closing') ? null : grid.totals[k][m]])) });
      row.font = { bold: k === 'closing' };
    }
    ws.addRow({ who: 'Balance per Xero', [period]: r.xero });
    ws.addRow({ who: 'Difference', [period]: r.difference }).font = { bold: true };
    if (curCol >= 6) {
      ws.getColumn(curCol).eachCell((c, n) => { if (n > 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4ECF8' } }; });
    }
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    (reg.notes || []).forEach((n) => ws.addRow({ who: n }));
  }

  // Aged ledgers
  for (const r of rows.filter((x) => x.detail && x.detail.byContact)) {
    const ws = wb.addWorksheet(r.rule === 'aged payables' ? 'Aged payables' : 'Aged receivables');
    header(ws, [
      { h: 'Contact', k: 'contact', w: 40 }, { h: 'Current', k: 'Current', money: true },
      { h: '1-30 days', k: '1-30 days', money: true }, { h: '31-60 days', k: '31-60 days', money: true },
      { h: '61-90 days', k: '61-90 days', money: true }, { h: 'Older', k: 'Older', money: true }, { h: 'Total', k: 'total', money: true },
    ]);
    r.detail.byContact.forEach((c) => ws.addRow(c));
    ws.addRow({ contact: 'Total', total: r.supporting }).font = { bold: true };
    ws.addRow({ contact: 'Balance per Xero', total: r.xero });
    ws.addRow({ contact: 'Difference', total: r.difference }).font = { bold: true };
    ws.addRow({});
    ws.addRow({ contact: 'Documents' }).font = { bold: true };
    r.detail.lines.forEach((l) => ws.addRow({ contact: `${l.contact || ''} · ${l.number} · ${l.date}${l.currency && l.currency !== entity.currency ? ` · ${l.currency} ${l.outstanding}` : ''}`, total: l.base }));
  }

  // Bank
  const banks = rows.filter((x) => x.rule === 'bank');
  if (banks.length) {
    const ws = wb.addWorksheet('Bank');
    header(ws, [
      { h: 'Account / transaction', k: 'a', w: 46 }, { h: 'Date', k: 'date', w: 12 }, { h: 'Type', k: 'type', w: 14 },
      { h: 'Reference', k: 'reference', w: 30 }, { h: 'Amount', k: 'total', money: true }, { h: 'Status', k: 'status', w: 16 },
    ]);
    for (const b of banks) {
      ws.addRow({ a: b.account, total: b.xero, status: b.status }).font = { bold: true };
      (b.detail.unreconciled || []).forEach((t) => ws.addRow({ a: `  ${t.contact || ''}`, date: String(t.date || '').slice(0, 10), type: t.type, reference: t.reference, total: t.total }));
    }
  }

  // Intercompany
  if (intercompany && entity.key === 'ltd') {
    const ws = wb.addWorksheet('Intercompany');
    header(ws, [{ h: 'Item', k: 'a', w: 52 }, { h: 'Value', k: 'v', w: 20 }]);
    ws.addRow({ a: `Inc owes Ltd (USD), ${intercompany.incAccount}`, v: intercompany.incUsd });
    ws.addRow({ a: 'USD/GBP rate at month end (GBP per USD)', v: intercompany.rate });
    ws.addRow({ a: 'Expected balance in Ltd (GBP)', v: intercompany.expectedGbp });
    ws.addRow({ a: `Balance per Ltd Xero, ${intercompany.ltdAccount}`, v: intercompany.ltdGbp });
    ws.addRow({ a: 'Difference', v: intercompany.difference }).font = { bold: true };
    ws.addRow({ a: intercompany.comment });
    ws.getColumn('v').numFmt = '#,##0.00####';
  }

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${entity.label} - Balance Sheet Reconciliation - ${monthLabel(period)}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

module.exports = { writeEntityPack, monthLabel };
