#!/usr/bin/env node
// Checks the setup end to end, read-only:
//   1. .env has the Xero app credentials and scopes
//   2. a Xero connection exists and covers ONLY Emperia Ltd and Emperia VR Inc
//   3. each org answers, with the expected base currency
//   4. every account name the rules and registers depend on exists in the chart
//
//   npm run doctor

require('dotenv').config();
const { ENTITIES, assertOnlyEmperia } = require('../src/config/entities');
const { loadTokenSet, grantedScopes, compareScopes } = require('../src/xero/tokenStore');
const { getOrganisation, getAccounts } = require('../src/xero/data');
const { loadRegisters } = require('../src/recon/registers');
const ACCOUNTS = require('../src/config/accounts');
const store = require('../src/store/store');

const fs = require('fs');
const path = require('path');

/** Closest chart names by shared words, then by shared letters. */
function suggest(target, candidates) {
  const words = (x) => new Set(String(x).toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 2));
  const tw = words(target);
  return candidates
    .map((c) => {
      const cw = words(c);
      const shared = [...tw].filter((w) => [...cw].some((v) => v.startsWith(w.slice(0, 5)) || w.startsWith(v.slice(0, 5)))).length;
      return { c, score: shared };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.length - b.c.length)
    .slice(0, 4)
    .map((x) => x.c);
}

let failed = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failed += 1; console.log(`  FAIL  ${m}`); };
const warn = (m) => console.log(`  warn  ${m}`);
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

async function main() {
  console.log('Configuration');
  for (const v of ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI', 'XERO_SCOPES']) {
    process.env[v] ? ok(`${v} set`) : bad(`${v} missing from .env`);
  }
  if (/write|manualjournals(?!\.read)/.test(process.env.XERO_SCOPES || '')) {
    warn('XERO_SCOPES includes a write scope. Phase 1 is read-only; remove it until phase 3.');
  }

  console.log('\nXero connection');
  const stored = loadTokenSet();
  if (!stored) {
    bad('Not connected. Run `npm run connect`, then open http://localhost:3000/auth/xero');
    return;
  }
  try {
    assertOnlyEmperia(stored.tenants, { requireAll: true });
    ok(`Connected to exactly: ${stored.tenants.map((t) => t.tenantName).join(', ')}`);
  } catch (err) {
    bad(err.message);
    return;
  }
  const scopes = compareScopes(process.env.XERO_SCOPES, grantedScopes());
  if (scopes.known && scopes.missing.length) bad(`Scopes in .env but not granted: ${scopes.missing.join(' ')}. Reconnect at /auth/xero.`);
  else if (scopes.known) ok('All configured scopes granted');

  for (const e of ENTITIES) {
    console.log(`\n${e.label}`);
    try {
      const org = await getOrganisation(e.key);
      org.baseCurrency === e.currency ? ok(`Base currency ${org.baseCurrency}`) : bad(`Base currency ${org.baseCurrency}, expected ${e.currency}`);
      const chart = await getAccounts(e.key);
      const names = new Set(chart.map((a) => norm(a.name)));
      // Save the chart locally (data/ is git-ignored) so account names can be
      // matched exactly without another Xero call.
      fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(__dirname, '..', 'data', `chart-${e.key}.json`),
        JSON.stringify(chart.map((a) => ({ code: a.code, name: a.name, class: a._class, type: a.type, status: a.status })), null, 2)
      );
      const needed = new Map();
      const cfg = ACCOUNTS[e.key] || {};
      if (cfg.intercompany) needed.set(cfg.intercompany, 'intercompany');
      if (cfg.fxRevaluation) needed.set(cfg.fxRevaluation, 'FX revaluation');
      store.ensureSeeded();
      for (const reg of loadRegisters(e.key, store.PATHS.registers)) {
        needed.set(reg.account, `register ${reg.register}`);
        for (const it of reg.items || []) if (it.expenseAccount) needed.set(it.expenseAccount, `release account in ${reg.register}`);
      }
      for (const [name, why] of needed) {
        if (names.has(norm(name))) { ok(`"${name}" (${why})`); continue; }
        bad(`"${name}" not in chart of accounts (${why}).`);
        const close = suggest(name, chart.map((a) => a.name));
        if (close.length) console.log(`        closest: ${close.map((n) => `"${n}"`).join(', ')}`);
      }
      const banks = chart.filter((a) => String(a.type).toUpperCase() === 'BANK').map((a) => a.name);
      ok(`${banks.length} bank account(s): ${banks.join(', ')}`);
    } catch (err) {
      bad(err.message);
    }
  }
}

main()
  .then(() => {
    console.log(failed ? `\n${failed} problem(s) found.` : '\nAll checks passed.');
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => { console.error(err.message); process.exit(1); });
