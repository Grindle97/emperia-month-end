# Putting the dashboard online

Railway runs the app. A Cloudflare Worker on workers.dev is the public address, and Cloudflare Access on that Worker is the login (Google or a one-time code, allow-listed emails only). The app checks Cloudflare's signed token on every request, so the raw Railway address is useless on its own.

```
browser ── Cloudflare Access (login) ── Worker (cloudflare/worker.js) ── Railway (this app + volume)
```

## 1. GitHub

Create a **private** repo `emperia-month-end`, then from this folder:

```
git init
git add .
git commit -m "Emperia month-end close"
git branch -M main
git remote add origin https://github.com/<you>/emperia-month-end.git
git push -u origin main
```

`.gitignore` keeps out `.env`, `data/` (tokens, runs, decisions), `out/` and the client workbooks in `docs/reference/`. The opening registers in `registers/` are committed, because the app seeds from them on first start.

## 2. Cloudflare Worker (the public address)

1. Cloudflare dashboard, Workers & Pages, Create, Worker. Name it `emperia-close`, deploy the default, then **Edit code**, paste `cloudflare/worker.js` and deploy.
2. Note its address: `https://emperia-close.<account>.workers.dev`.
3. Leave `ORIGIN` for now; it is set once Railway exists (step 4).

## 3. Cloudflare Access (the login)

1. Zero Trust, Access, Applications, Add, **Self-hosted**, domain `emperia-close.<account>.workers.dev`.
2. Policy: Allow, Include **Emails**: you and your colleague. Login: Google and one-time PIN. Session: 24 hours.
3. Copy the **Application Audience (AUD) tag** and your team domain (`https://<team>.cloudflareaccess.com`) into `.env` as `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`.

## 4. Railway

1. New project, Deploy from GitHub repo, `emperia-month-end`.
2. **Add a volume first**, mounted at `/app/data`. Without it, everything the dashboard saves is wiped on each deploy.
3. Add your colleague to `USER_ROLES` in `.env` (e.g. `...,colleague@joinrora.com:admin`), then run:
   ```
   node scripts/railway-env.js https://emperia-close.<account>.workers.dev
   ```
   Paste `railway-env.txt` into Variables, Raw Editor. Delete the file.
4. Settings, Networking, Generate domain. Copy the `*.up.railway.app` address into the Worker's variable `ORIGIN` (Worker, Settings, Variables) and redeploy the Worker.

## 5. Xero

1. In the Emperia Xero app, add redirect URI `https://emperia-close.<account>.workers.dev/auth/xero/callback` (keep the localhost one).
2. Open the connect link the script printed (`.../auth/xero?token=...`), tick **Emperia** and **Emperia VR Inc** only.

## 6. Check

- `https://emperia-close.<account>.workers.dev` asks you to sign in, then shows the dashboard.
- The `*.up.railway.app` address on its own says "Not signed in".
- Run September and compare with your local run.
- Your colleague signs in with their email.

To add or remove someone later, change **both** the Cloudflare Access policy and `USER_ROLES` on Railway.
