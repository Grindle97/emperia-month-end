// One-time OAuth flow, connecting one or more Xero organisations at once.
//
// Run the server, visit GET /auth/xero in a browser while logged into
// Xero, approve the consent screen (ticking every org this bot should
// access, if your login has more than one), and Xero redirects back to
// /auth/xero/callback with a code. We exchange that for a token set and
// persist it — along with the full list of authorized orgs — via tokenStore.
//
// You only need to repeat this if the refresh token itself is revoked
// (e.g. 60 days of inactivity, someone removes the app in Xero), or if
// you want to add/remove which orgs are authorized.
//
// SECURITY — this matters once the app is deployed rather than run on a
// laptop. On a hosting platform the port you listen on IS a public URL, so
// these two routes become reachable by anyone on the internet. They don't
// serve financial data, but an unprotected callback lets a stranger
// complete an OAuth flow and REPLACE the stored Xero connection with a
// different organisation's — after which the agent answers confidently from
// someone else's books. Two guards close that:
//
//   1. AUTH_SETUP_TOKEN — when set, /auth/xero requires ?token=<value>.
//      Connecting is a once-per-deployment action, so needing a secret in
//      the URL costs nothing and takes the endpoint off the open internet.
//   2. OAuth `state` — a random value issued when the flow starts and
//      required to match on return. This is standard CSRF protection for
//      OAuth and was missing entirely; without it the callback accepts a
//      code from anyone who sends one.
//
// The cleanest deployment posture is not to expose this at all: run the
// OAuth locally, then upload the resulting token file to the host as a
// secret. See DEPLOYMENT.md.

const express = require('express');
const { buildClient } = require('../xero/xeroClient');
const { saveTokenSet } = require('../xero/tokenStore');
const { describeXeroError } = require('../xero/xeroError');
const { assertOnlyEmperia } = require('../config/entities');
const APP_NAME = 'The Emperia close agent';
// State/secret handling lives in its own module so it can be unit-tested —
// it broke the first production connection attempt.
const { issueState, consumeState, stripStateParam, secretsMatch } = require('./oauthState');

const router = express.Router();

const AUTH_SETUP_TOKEN = process.env.AUTH_SETUP_TOKEN || '';

router.get('/xero', async (req, res) => {
  if (AUTH_SETUP_TOKEN && !secretsMatch(req.query.token || '', AUTH_SETUP_TOKEN)) {
    console.warn('Rejected /auth/xero — missing or wrong setup token.');
    return res.status(404).send('Not found.');
  }

  try {
    const client = buildClient();
    await client.initialize();
    const consentUrl = await client.buildConsentUrl();

    // Appended manually rather than relying on a particular xero-node
    // version's state support, so this keeps working across upgrades.
    const state = issueState();
    const url = new URL(consentUrl);
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  } catch (err) {
    // describeXeroError, never the raw error. xero-node <7.1.0 packed the
    // REQUEST HEADERS into its error object — Authorization, and on the token
    // endpoints the client secret and refresh token with it — so logging `err`
    // wrote live credentials into Railway's log. Xero disclosed this on 23 Sep.
    // The SDK is upgraded, and this stays as the second lock: describeXeroError
    // reads only the status and the response body, never headers.
    console.error('Failed to build Xero consent URL:', describeXeroError(err).message);
    res.status(500).send('Failed to start Xero connection. Check server logs.');
  }
});

router.get('/xero/callback', async (req, res) => {
  if (!consumeState(req.query.state)) {
    console.warn('Rejected /auth/xero/callback — unknown, expired or reused state.');
    return res.status(400).send(
      'This connection link is invalid or has expired. Start again at /auth/xero.'
    );
  }

  try {
    const client = buildClient();
    await client.initialize();

    // Strip our `state` before handing the URL to xero-node.
    //
    // xero-node passes the callback through openid-client, which throws
    // `checks.state argument is missing` whenever the response carries a
    // state it wasn't separately told to expect — and xero-node's
    // apiCallback() has no way to pass that expectation through. Since we
    // already validated the state ourselves above (single-use, TTL-bounded),
    // removing it here keeps the CSRF protection while letting the token
    // exchange proceed. Dropping the state parameter entirely would be the
    // other way to satisfy openid-client, but that would mean no CSRF
    // protection at all on an internet-reachable callback.
    // See oauthState.stripStateParam for why this is necessary and why it
    // must not go through URLSearchParams.
    const cleanedUrl = stripStateParam(req.url);

    // apiCallback exchanges the ?code= for a token set
    const tokenSet = await client.apiCallback(cleanedUrl);
    await client.updateTenants(false);

    const tenants = client.tenants;
    if (!tenants || tenants.length === 0) {
      return res.status(400).send('Connected, but no Xero organisations were authorised.');
    }

    // Save every authorized org, not just one — the agent can target a
    // specific org per query, or query more than one and combine results.
    const tenantList = tenants.map((t) => ({ tenantId: t.tenantId, tenantName: t.tenantName }));
    // Emperia only. A connection that also covers another client's org is
    // refused outright and never saved.
    try {
      assertOnlyEmperia(tenantList);
    } catch (guardErr) {
      console.warn('Rejected Xero connection:', guardErr.message);
      return res.status(400).send(
        `Not saved. ${guardErr.message.replace(/</g, '&lt;')}<br><br>` +
        'In Xero, open Settings &gt; Connected apps, disconnect this app from those organisations, then start again at /auth/xero.'
      );
    }
    saveTokenSet(tokenSet, tenantList);

    console.log(`Xero connected: ${tenantList.map((t) => t.tenantName).join(', ')}`);
    const namesList = tenantList.map((t) => t.tenantName).join('<br>');

    res.send(
      `Connected. ${APP_NAME} now has access to:<br><br>${namesList}<br><br>` +
      `You can close this tab.`
    );
  } catch (err) {
    // The most dangerous of the three sites: this one surrounds the TOKEN
    // exchange, where the request carries the client secret and the refresh
    // token rather than just an access token.
    console.error('Xero OAuth callback failed:', describeXeroError(err).message);
    res.status(500).send('Xero connection failed. Check server logs.');
  }
});

module.exports = router;
