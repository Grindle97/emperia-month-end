#!/usr/bin/env node
// Prints the Railway variables from your .env, with the production values
// set, ready to paste into Railway > Variables > Raw Editor.
// Writes railway-env.txt (git-ignored). Delete it once pasted.
//
//   node scripts/railway-env.js https://emperia-close.<account>.workers.dev

require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');

const publicUrl = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(publicUrl)) {
  console.error('Pass the public address, e.g. node scripts/railway-env.js https://emperia-close.<account>.workers.dev');
  process.exit(1);
}
const keep = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_SCOPES', 'XERO_ORG_NAME_LTD', 'XERO_ORG_NAME_INC', 'USER_ROLES', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD'];
const vars = Object.fromEntries(keep.map((k) => [k, process.env[k] || '']));
Object.assign(vars, {
  NODE_ENV: 'production',
  PORT: '8080',
  PUBLIC_URL: publicUrl,
  XERO_REDIRECT_URI: `${publicUrl}/auth/xero/callback`,
  DATA_DIR: '/app/data',
  TOKEN_STORE_PATH: '/app/data/xero-tokens-emperia.json',
  AUTH_SETUP_TOKEN: process.env.AUTH_SETUP_TOKEN || crypto.randomBytes(24).toString('hex'),
});
const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
const text = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
fs.writeFileSync('railway-env.txt', text);
console.log('Wrote railway-env.txt. Paste it into Railway > Variables > Raw Editor, then delete the file.');
console.log(`Xero connect link once live: ${publicUrl}/auth/xero?token=${vars.AUTH_SETUP_TOKEN}`);
if (missing.length) console.log(`Still blank (fill in before deploying): ${missing.join(', ')}`);
