// Simple in-memory cache for Xero API calls, 1-hour TTL.
//
// Xero data changes throughout the working day, so this window is
// deliberately short — long enough to catch a repeat/similar question
// within the same working session, short enough that a stale answer is
// a minor inconvenience rather than a real risk.

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map(); // key -> { value, cachedAt }

function makeKey(fnName, params) {
  return `${fnName}:${JSON.stringify(params)}`;
}

/**
 * Runs `fetcher()` and caches the result under a key built from `fnName`
 * + `params`, unless a still-fresh cached value already exists for that
 * exact combination.
 */
async function cached(fnName, params, fetcher) {
  const key = makeKey(fnName, params);
  const entry = cache.get(key);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL_MS) {
    return entry.value;
  }
  const value = await fetcher();
  cache.set(key, { value, cachedAt: Date.now() });
  return value;
}

/**
 * Drop every cached value. Called when the Xero CONNECTION changes, which is
 * the one event this cache cannot survive: the key is fnName + params, and for
 * a single-org deployment `entity` is undefined in every call, so nothing in
 * the key identifies WHICH organisation the value came from. Reconnect a
 * different org without clearing, and the identical question keeps returning
 * the previous org's figures for up to an hour - under the new org's name,
 * with no restart to flush it and nothing in the logs to suggest it.
 */
function clearAll() {
  const n = cache.size;
  cache.clear();
  return n;
}

module.exports = { cached, clearAll };
