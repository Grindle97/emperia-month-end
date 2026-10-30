#!/usr/bin/env node
// Run the month-end reconciliation against live Xero (read-only).
//
//   npm run close -- --period 2026-10
//   npm run close -- --period 2026-10 --usd-gbp 0.7712 --entity ltd
//
// Writes one Excel pack per entity to out/<period>/ and a JSON copy of the
// results alongside it. Posts nothing to Xero.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { runClose, xeroSource } = require('../src/recon/close');
const { writeEntityPack } = require('../src/output/pack');
const { loadTokenSet } = require('../src/xero/tokenStore');
const { assertOnlyEmperia } = require('../src/config/entities');
const store = require('../src/store/store');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function defaultPeriod() {
  const d = new Date();
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return prev.toISOString().slice(0, 7);
}

async function main() {
  const period = arg('period') || defaultPeriod();
  const entityArg = arg('entity');
  const entities = entityArg ? [entityArg] : ['ltd', 'inc'];
  const usdGbp = arg('usd-gbp') ? Number(arg('usd-gbp')) : undefined;

  const stored = loadTokenSet();
  if (!stored) throw new Error('Not connected to Xero yet. Run `npm run connect` and visit http://localhost:3000/auth/xero.');
  assertOnlyEmperia(stored.tenants, { requireAll: entities.length === 2 });

  console.log(`Emperia close ${period}: ${entities.join(', ')} (read-only)`);
  store.ensureSeeded(); // same registers and inputs as the dashboard
  const results = await runClose({ period, entities, usdGbp, source: xeroSource(), registerDir: store.PATHS.registers, inputDir: store.PATHS.inputs });

  const outDir = path.join(__dirname, '..', 'out', period);
  fs.mkdirSync(outDir, { recursive: true });
  for (const key of entities) {
    const file = await writeEntityPack(results[key], results.intercompany, outDir, { registerDir: store.PATHS.registers });
    const counts = results[key].rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    console.log(`\n${results[key].entity.label}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    for (const r of results[key].rows.filter((x) => ['Break', 'Journal proposed', 'Needs input'].includes(x.status))) {
      console.log(`  ${r.status.padEnd(17)} ${r.account}${r.difference !== null ? `  diff ${r.difference.toFixed(2)}` : ''}`);
    }
    results[key].warnings.forEach((w) => console.log(`  Warning: ${w}`));
    console.log(`  Pack: ${file}`);
  }
  if (results.intercompany) console.log(`\nIntercompany: ${results.intercompany.status}. ${results.intercompany.comment}`);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`\nClose failed: ${err.message}`);
  process.exit(1);
});
