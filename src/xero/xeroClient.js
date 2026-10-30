// Wraps xero-node's XeroClient so the rest of the app never has to think
// about token refresh — call getAuthenticatedClient() and you get back a
// client that's guaranteed to have a valid (refreshed if needed) access
// token, targeting whichever Xero organisation you ask for.

const { XeroClient } = require('xero-node');
const { loadTokenSet, updateTokenSetOnly } = require('./tokenStore');
const { assertOnlyEmperia, entityForTenantName } = require('../config/entities');

/**
 * XERO_SCOPES into a clean list.
 *
 * Was `.split(' ')` — a single literal space. Paste the variable into a hosting
 * platform's raw editor from Windows and a line break or a stray \r survives
 * inside the value, so "accounting.payments.read\r\naccounting.attachments"
 * reaches Xero as ONE mangled scope. Xero then answers "invalid scope" and
 * authorises NOTHING — one unrecognised entry fails the whole consent request
 * rather than being skipped — which reads as a problem with the scope you just
 * added rather than with the whitespace around it.
 *
 * Splits on any run of whitespace, and drops a stray comma or quote, since a
 * comma-separated paste is the other way people write these.
 */
function parseScopes(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((sc) => sc.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

function buildClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUris: [process.env.XERO_REDIRECT_URI],
    scopes: parseScopes(process.env.XERO_SCOPES),
  });
}

/**
 * List every Xero organisation currently authorized under the stored
 * connection. Does not require a live API call — reads from what was
 * saved at connect time.
 * @returns {Array<{tenantId: string, tenantName: string}>}
 */
function getAvailableTenants() {
  const stored = loadTokenSet();
  return stored?.tenants || [];
}

/**
 * Returns a XeroClient with a valid access token set, refreshing via the
 * stored refresh token if needed, targeting a specific organisation.
 *
 * @param {string} [tenantName] - which org to target, matched case-
 *   insensitively against the names captured at connect time. If omitted:
 *     - with exactly one authorized org, that one is used
 *     - with more than one, throws — callers must specify, since picking
 *       silently could return the wrong entity's data
 * @returns {Promise<{client: XeroClient, tenantId: string, tenantName: string}>}
 */
async function getAuthenticatedClient(tenantName) {
  const stored = loadTokenSet();
  if (!stored || !stored.tokenSet || !stored.tenants?.length) {
    throw new Error(
      'No Xero connection found. Visit /auth/xero to connect a Xero org first.'
    );
  }

  // Refuse to touch anything if a non-Emperia organisation is connected.
  assertOnlyEmperia(stored.tenants);

  let tenant;
  if (tenantName) {
    const wanted = entityForTenantName(tenantName);
    tenant = stored.tenants.find(
      (t) => (t.tenantName || '').trim().toLowerCase() === tenantName.trim().toLowerCase() ||
        (wanted && entityForTenantName(t.tenantName) === wanted)
    );
    if (!tenant) {
      const available = stored.tenants.map((t) => t.tenantName).join(', ');
      throw new Error(`No connected Xero org matches "${tenantName}". Available: ${available}`);
    }
  } else if (stored.tenants.length === 1) {
    tenant = stored.tenants[0];
  } else {
    const available = stored.tenants.map((t) => t.tenantName).join(', ');
    throw new Error(`Multiple Xero orgs are connected (${available}) — specify which one.`);
  }

  const client = buildClient();

  // Required before the client can do anything token-related (refresh,
  // API calls) — sets up the internal OpenID client.
  await client.initialize();

  client.setTokenSet(stored.tokenSet);

  if (client.readTokenSet().expired()) {
    const refreshed = await client.refreshToken();
    // Only the token itself changes on refresh — the authorized tenants
    // list doesn't, so we update just that part rather than re-saving.
    updateTokenSetOnly(refreshed);
  }

  return { client, tenantId: tenant.tenantId, tenantName: tenant.tenantName };
}

module.exports = {
  parseScopes, buildClient, getAuthenticatedClient, getAvailableTenants };
