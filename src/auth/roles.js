// Who may use the Emperia close dashboard, and what each person may do.
//
// Two locks, deliberately independent:
//   1. Cloudflare Access decides who reaches the app at all (access.js).
//   2. This allow-list decides what a verified person may do once inside.
//
// USER_ROLES is "email:role" pairs, comma-separated:
//   USER_ROLES=reece@joinrora.com:admin,analyst@example.com:preparer
//
// Fails closed: blank or unparseable means nobody gets in.

const ROLES = {
  // RORA: everything, plus connecting Xero.
  admin: ['view', 'run', 'input', 'explain', 'review', 'approve', 'signoff', 'admin'],
  // Signs off the close and approves journals.
  approver: ['view', 'explain', 'review', 'approve', 'signoff'],
  // The analyst: runs the close, enters inputs, explains and reviews. Cannot
  // approve journals or sign off, so preparing and approving stay separate.
  preparer: ['view', 'run', 'input', 'explain', 'review'],
  // Read only.
  viewer: ['view'],
};

function parseUserRoles(raw = process.env.USER_ROLES || '') {
  const map = new Map();
  for (const pair of String(raw).split(',')) {
    const [email, role] = pair.split(':').map((s) => (s || '').trim().toLowerCase());
    if (!email || !role) continue;
    if (!ROLES[role]) {
      console.warn(`USER_ROLES: unknown role "${role}" for ${email}; ignored.`);
      continue;
    }
    map.set(email, role);
  }
  return map;
}

function roleFor(email, raw) {
  if (!email) return null;
  return parseUserRoles(raw).get(String(email).trim().toLowerCase()) || null;
}

function capabilitiesFor(role) {
  return role && ROLES[role] ? [...ROLES[role]] : [];
}

module.exports = { ROLES, parseUserRoles, roleFor, capabilitiesFor };
