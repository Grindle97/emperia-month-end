# Setup: connecting Emperia's Xero (phase 1, read-only)

About 10 minutes. You need to be able to log in to both Emperia organisations in Xero.

## 1. Create a Xero app for Emperia

1. Go to [developer.xero.com/app/manage](https://developer.xero.com/app/manage) and choose **New app**.
2. App name: `RORA Emperia Close` (any name; it shows on the consent screen).
3. Integration type: **Web app**.
4. Company or application URL: `https://joinrora.com`.
5. Redirect URI: `http://localhost:3000/auth/xero/callback`.
6. Create it, then under **Configuration** generate a client secret.

Use a new app for Emperia rather than reusing another client's app, so the connection, token and consent are Emperia's alone.

## 2. Fill in `.env`

```
cp .env.example .env
```

Paste the client ID and secret. Leave `XERO_SCOPES` as it is: read-only.

## 3. Install and connect

```
npm install
npm run connect
```

Open [http://localhost:3000/auth/xero](http://localhost:3000/auth/xero). On Xero's consent screen tick **only Emperia Ltd and Emperia VR Inc**. If anything else is ticked the agent refuses to save the connection.

Stop the server (Ctrl+C) once it says connected.

## 4. Check it

```
npm run doctor
```

It confirms both organisations are connected (and nothing else), the base currencies are GBP and USD, and every account name the registers rely on exists in the chart of accounts. If an account name differs, fix it in `src/config/accounts.js` or the register file.

## 5. Run a close

```
npm run close -- --period 2026-10 --usd-gbp <rate at 31 Oct>
```

Or put the rate in `inputs/fx/2026-10.json` as `{ "USDGBP": 0.77 }`. Bank statement balances go in `inputs/statements/ltd/2026-10.json` and `inputs/statements/inc/2026-10.json`, keyed by the Xero bank account name:

```json
{ "Revolut GBP Main": 8817.08, "Revolut USD Main": 65165.03 }
```

Packs are written to `out/2026-10/`.
