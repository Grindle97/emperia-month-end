// OAuth CSRF-state handling for the Xero connect flow.
//
// Extracted from auth.js so it can be tested directly — this logic broke the
// first production connection attempt, and it's the kind of thing that fails
// in ways the error message actively misleads you about (see stripStateParam).

const crypto = require('crypto');

const STATE_TTL_MS = 15 * 60 * 1000; // a consent screen left open longer than this is stale

// Issued states, in memory. A restart between starting and finishing the flow
// invalidates it, which is correct — better to redo a 30-second consent than
// to accept a state we can no longer vouch for.
const pendingStates = new Map(); // state -> issuedAt

function issueState() {
  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.set(state, Date.now());
  // Opportunistic cleanup — this map only grows on abandoned flows.
  for (const [s, issuedAt] of pendingStates) {
    if (Date.now() - issuedAt > STATE_TTL_MS) pendingStates.delete(s);
  }
  return state;
}

/** Single-use: a state is consumed whether or not it turns out to be valid. */
function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const issuedAt = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() - issuedAt <= STATE_TTL_MS;
}

/**
 * Remove our `state` parameter from a callback URL, leaving every other
 * parameter byte-identical.
 *
 * Why this exists: xero-node routes the callback through openid-client, which
 * throws `checks.state argument is missing` for any response carrying a state
 * it wasn't separately told to expect — and apiCallback() gives no way to pass
 * that expectation through. We validate the state ourselves and then strip it.
 *
 * Why it splits the string rather than using URL/URLSearchParams: re-serialising
 * normalises encoding ('~' becomes %7E, ' ' becomes '+'), which risks altering
 * the authorization `code` and failing the exchange for reasons that look
 * nothing like the cause.
 */
function stripStateParam(reqUrl) {
  const [path, query = ''] = String(reqUrl).split('?');
  const kept = query.split('&').filter((part) => part && !/^state=/.test(part));
  return kept.length ? `${path}?${kept.join('&')}` : path;
}

/** Timing-safe comparison; hashes first so unequal lengths don't throw. */
function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { issueState, consumeState, stripStateParam, secretsMatch, STATE_TTL_MS };
