// Balance sheet sections, in Xero's order, from each account's Xero type.

const SECTIONS = [
  { key: 'bank', cls: 'ASSET', label: 'Bank', types: ['BANK'] },
  { key: 'current-assets', cls: 'ASSET', label: 'Current assets', types: ['CURRENT', 'PREPAYMENT', 'INVENTORY'] },
  { key: 'fixed-assets', cls: 'ASSET', label: 'Fixed assets', types: ['FIXED'] },
  { key: 'noncurrent-assets', cls: 'ASSET', label: 'Non-current assets', types: ['NONCURRENT'] },
  { key: 'current-liabilities', cls: 'LIABILITY', label: 'Current liabilities', types: ['CURRLIAB', 'LIABILITY'] },
  { key: 'noncurrent-liabilities', cls: 'LIABILITY', label: 'Non-current liabilities', types: ['TERMLIAB'] },
  { key: 'equity', cls: 'EQUITY', label: 'Equity', types: ['EQUITY'] },
];
const CLASSES = [['ASSET', 'Assets'], ['LIABILITY', 'Liabilities'], ['EQUITY', 'Equity']];

function sectionFor(cls, type) {
  const t = String(type || '').toUpperCase();
  const hit = SECTIONS.find((s) => s.cls === cls && s.types.includes(t));
  if (hit) return hit.key;
  // Unknown type: the first section of its class.
  return (SECTIONS.find((s) => s.cls === cls) || SECTIONS[1]).key;
}

/** rows -> [{cls, label, sections: [{key, label, rows, total}], total}] in order. */
function groupRows(rows) {
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  return CLASSES.map(([cls, label]) => {
    const sections = SECTIONS.filter((s) => s.cls === cls).map((s) => {
      const r = rows.filter((x) => x.section === s.key).sort((a, b) => a.account.localeCompare(b.account));
      return { key: s.key, label: s.label, rows: r, total: round2(r.reduce((t, x) => t + (x.xero || 0), 0)) };
    }).filter((s) => s.rows.length);
    return { cls, label, sections, total: round2(sections.reduce((t, s) => t + s.total, 0)) };
  }).filter((g) => g.sections.length);
}

module.exports = { SECTIONS, sectionFor, groupRows };
