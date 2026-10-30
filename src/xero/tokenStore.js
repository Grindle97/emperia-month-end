// Minimal file-based persistence for Xero OAuth token sets.
//
// One token set can authorize access to MULTIPLE Xero organisations (if
// your Xero login has access to more than one and you approve them all
// on the consent screen) — Xero doesn't require a separate connection per
// org. So this stores one token set plus the full list of authorized
// organisations, and callers pick which org to target per API call.
//
// This is fine to get the integration running end-to-end, but it is NOT
// where you want to leave this for production:
//   - a single JSON file on disk doesn't survive redeploys on most hosts
//   - it has no encryption at rest
//
// Swap this module for a proper store (Postgres table, AWS Secrets Manager,
// etc.) later — everything else in the project only talks to the functions
// below, so the swap is contained to this file.

const fs = require('fs');
const path = require('path');
// Cached Xero answers belong to the connection that produced them, so they
// have to go when it is replaced. Hooked in HERE rather than in the OAuth
// route so that every path which swaps the connection is covered, including
// any future one - a caller cannot forget to do it.
const { clearAll: clearXeroCache } = require('./xeroCache');

const STORE_PATH = process.env.TOKEN_STORE_PATH || './data/xero-tokens-emperia.json';

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Persist a Xero token set along with every organisation it's authorized
 * to access.
 * @param {object} tokenSet - the token set object returned by xero-node
 * @param {Array<{tenantId: string, tenantName: string}>} tenants - every
 *   org authorized under this token set
 */
function saveTokenSet(tokenSet, tenants) {
  const dropped = clearXeroCache();
  if (dropped > 0) {
    console.log(`Xero connection replaced — dropped ${dropped} cached response(s).`);
  }
  ensureDir();
  const data = {
    tokenSet,
    tenants,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Load the persisted token set, if any.
 * @returns {{tokenSet: object, tenants: Array<{tenantId: string, tenantName: string}>, savedAt: string} | null}
 */
function loadTokenSet() {
  if (!fs.existsSync(STORE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch (err) {
    console.error('Failed to parse stored Xero token set:', err.message);
    return null;
  }
}

function updateTokenSetOnly(tokenSet) {
  const existing = loadTokenSet();
  if (!existing) return;
  ensureDir();
  fs.writeFileSync(
    STORE_PATH,
    JSON.stringify({ ...existing, tokenSet }, null, 2),
    'utf-8'
  );
}

function clearTokenSet() {
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
}

/**
 * The scopes Xero ACTUALLY granted, which is not the same thing as XERO_SCOPES.
 *
 * Scopes are fixed at consent time. Worse, a reconnect does not necessarily
 * re-consent: with an active connection Xero can skip the consent screen
 * entirely and hand back a fresh token carrying the PREVIOUS scope set. So the
 * variable and the grant can disagree indefinitely, and the only symptom is a
 * 403 the first time someone uses the feature.
 */
function grantedScopes() {
  const stored = loadTokenSet();
  const raw = stored && stored.tokenSet && stored.tokenSet.scope;
  return String(raw || '').split(/\s+/).filter(Boolean);
}

/**
 * Which configured scopes were never granted.
 * Pure, so it can be asserted without a token file.
 * @returns {{missing: string[], granted: string[], configured: string[], known: boolean}}
 *   `known` is false when the token carries no scope list at all — in which
 *   case nothing can be concluded, which must not be reported as "all fine".
 */
function compareScopes(configuredRaw, grantedList) {
  const configured = String(configuredRaw || '').split(/\s+/).filter(Boolean);
  const granted = (grantedList || []).filter(Boolean);
  if (granted.length === 0) {
    return { missing: [], granted, configured, known: false };
  }
  const have = new Set(granted);
  return { missing: configured.filter((c) => !have.has(c)), granted, configured, known: true };
}

module.exports = {
  saveTokenSet, loadTokenSet, updateTokenSetOnly, clearTokenSet,
  grantedScopes, compareScopes,
};
