#!/usr/bin/env node
// Runs the close engine on the September 2026 balances taken from the
// analyst's workbooks (test/fixtures.js) and writes sample packs to
// out/demo-2026-09/. No Xero connection needed: this is how to see the
// output before the live connection exists.

const path = require('path');
const { runClose } = require('../src/recon/close');
const { writeEntityPack } = require('../src/output/pack');
const { fixtureSource } = require('../test/fixtures');

const bill = (contact, total, date = '2026-09-15', due = '2026-10-15') =>
  ({ contact: { name: contact }, total, date, dueDate: due, payments: [], currencyCode: 'GBP', currencyRate: 1 });

(async () => {
  const LTD_AP = {
    invoices: [
      bill('Amazon Web Services', 1940.51), bill('F. INITIATIVES LIMITED', 4158.0), bill('Google', 308.59),
      bill('Rebank Technologies Limited', 12212.96, '2026-08-10', '2026-08-20'),
      bill('RORA - Quantico Analytics Limited', 4380.0), bill('Sohoworks', 330.0, '2026-05-01', '2026-06-01'),
      bill('Unconditionally Human Ltd', 360.0),
    ],
    credits: [{ contact: { name: 'Ahmad Sarfraz' }, total: 1716.26, date: '2025-01-10', allocations: [], payments: [], _kind: 'credit note' }],
  };
  const results = await runClose({ period: '2026-09', source: fixtureSource({ aged: { ltd: { ACCPAY: LTD_AP } } }) });
  const outDir = path.join(__dirname, '..', 'out', 'demo-2026-09');
  for (const key of ['ltd', 'inc']) {
    console.log(await writeEntityPack(results[key], results.intercompany, outDir));
  }
  console.log(`Intercompany: ${results.intercompany.comment}`);
})();
