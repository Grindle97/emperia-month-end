// The two Emperia entities this project serves, and the guard that keeps it
// to them.
//
// ISOLATION: this project is for Emperia only. It has its own Xero app, its
// own token file and its own registers, and it must never read another
// client's books. The guard below runs on every Xero call and at connect
// time: if the stored connection includes ANY organisation that is not one of
// these two, the agent refuses to run rather than quietly ignoring the extra
// org. Untick other organisations on the Xero consent screen.

const ENTITIES = [
  {
    key: 'ltd',
    label: 'Emperia Ltd',
    xeroName: process.env.XERO_ORG_NAME_LTD || 'Emperia Ltd',
    currency: 'GBP',
  },
  {
    key: 'inc',
    label: 'Emperia VR Inc',
    xeroName: process.env.XERO_ORG_NAME_INC || 'Emperia VR Inc',
    currency: 'USD',
  },
];

function normaliseOrgName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\blimited\b/g, 'ltd')
    .replace(/\bincorporated\b/g, 'inc')
    .replace(/\s+/g, ' ')
    .trim();
}

function entityByKey(key) {
  const e = ENTITIES.find((x) => x.key === key);
  if (!e) throw new Error(`Unknown entity "${key}". Use one of: ${ENTITIES.map((x) => x.key).join(', ')}`);
  return e;
}

function entityForTenantName(tenantName) {
  const n = normaliseOrgName(tenantName);
  return ENTITIES.find((e) => normaliseOrgName(e.xeroName) === n) || null;
}

/**
 * Throws unless every connected tenant is an Emperia entity.
 * Pure: takes the tenant list, so it can be tested without a token file.
 * @param {Array<{tenantName: string}>} tenants
 * @param {{requireAll?: boolean}} [opts] - also require both entities present
 */
function assertOnlyEmperia(tenants, opts = {}) {
  const list = tenants || [];
  const foreign = list.filter((t) => !entityForTenantName(t.tenantName));
  if (foreign.length) {
    throw new Error(
      `This connection includes organisations that are not Emperia: ${foreign.map((t) => t.tenantName).join(', ')}. ` +
      'The Emperia close agent only runs against Emperia Ltd and Emperia VR Inc. Reconnect at /auth/xero and tick only those two.' +
      (foreign.some((t) => /emperia/i.test(t.tenantName))
        ? ' If one of these IS an Emperia entity under a different Xero name, set XERO_ORG_NAME_LTD or XERO_ORG_NAME_INC in .env to that exact name.'
        : '')
    );
  }
  if (opts.requireAll) {
    const missing = ENTITIES.filter((e) => !list.some((t) => entityForTenantName(t.tenantName) === e));
    if (missing.length) {
      throw new Error(
        `Not connected to: ${missing.map((e) => e.xeroName).join(', ')}. ` +
        'If the Xero name differs, set XERO_ORG_NAME_LTD / XERO_ORG_NAME_INC in .env to match it exactly.'
      );
    }
  }
  return true;
}

module.exports = { ENTITIES, entityByKey, entityForTenantName, assertOnlyEmperia, normaliseOrgName };
