// The login gate, as seen from inside the app.
//
// Cloudflare Access sits in front of the app's address: nobody reaches it
// without an allow-listed email plus Google sign-in or a one-time code. When a
// request is let through, Cloudflare adds a signed token (a JWT) in the
// Cf-Access-Jwt-Assertion header.
//
// The Railway service also has its own *.up.railway.app address, which does
// NOT go through Cloudflare. So the app never trusts "the request arrived" as
// proof of anything: every request must carry a token Cloudflare signed for
// THIS application (audience tag) from THIS team (issuer), checked against
// Cloudflare's published keys. Anything else gets a 401.
//
// Local development: with NODE_ENV not "production" and no Cloudflare
// settings, DEV_USER_EMAIL stands in for the signed-in person. In production
// that path is refused outright, so a missing setting fails closed.

const { createRemoteJWKSet, jwtVerify, decodeJwt } = require('jose');
const { roleFor, capabilitiesFor } = require('./roles');

const TEAM_DOMAIN = (process.env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
const AUDIENCE = (process.env.CF_ACCESS_AUD || '').trim();
const IS_PROD = process.env.NODE_ENV === 'production';

let jwks = null;
function keys() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`));
  return jwks;
}

function accessConfigured() {
  return Boolean(TEAM_DOMAIN && AUDIENCE);
}

async function verifyAccessToken(token, { keySet = null, issuer = TEAM_DOMAIN, audience = AUDIENCE } = {}) {
  const { payload } = await jwtVerify(token, keySet || keys(), { issuer, audience });
  if (!payload.email) throw new Error('Access token has no email claim');
  return String(payload.email).toLowerCase();
}

function tokenFrom(req) {
  const header = req.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = req.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

/** Sets req.user = { email, role, capabilities } or ends the request. */
function requireUser(opts = {}) {
  const verify = opts.verify || verifyAccessToken;
  const env = opts.env || process.env;
  return async (req, res, next) => {
    let email = null;
    try {
      if (!IS_PROD && env.DEV_USER_EMAIL && !opts.verify) {
        // Local only: never in production, whatever else is set.
        email = String(env.DEV_USER_EMAIL).toLowerCase();
      } else if (accessConfigured() || opts.verify) {
        const token = tokenFrom(req);
        if (!token) return deny(res, 401, 'Not signed in.');
        email = await verify(token);
      } else {
        console.error('Refusing request: Cloudflare Access is not configured (CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD).');
        return deny(res, 503, 'Sign-in is not configured.');
      }
    } catch (err) {
      let seen = {};
      try { const c = decodeJwt(tokenFrom(req) || ''); seen = { iss: c.iss, aud: c.aud }; } catch { /* not a JWT */ }
      console.warn('Rejected request with an invalid access token:', err.code || err.message,
        JSON.stringify({ tokenIss: seen.iss, tokenAud: seen.aud, expectedIss: TEAM_DOMAIN, expectedAud: AUDIENCE }));
      return deny(res, 401, 'Your sign-in could not be verified. Please sign in again.');
    }
    const role = roleFor(email, env.USER_ROLES);
    if (!role) {
      console.warn(`Signed in but not on the allow-list: ${email}`);
      return deny(res, 403, 'Your account does not have access to this app.');
    }
    req.user = { email, role, capabilities: capabilitiesFor(role) };
    return next();
  };
}

function requireCapability(capability) {
  return (req, res, next) => {
    if (req.user && req.user.capabilities.includes(capability)) return next();
    return deny(res, 403, 'You do not have access to this.');
  };
}

function deny(res, status, message) {
  if ((res.req.get('Accept') || '').includes('text/html')) {
    return res.status(status).type('text/plain').send(message);
  }
  return res.status(status).json({ error: message });
}

module.exports = { requireUser, requireCapability, verifyAccessToken, accessConfigured, tokenFrom };
