// Emperia close dashboard.
//
//   npm start            then http://localhost:3000
//
// Locally: set DEV_USER_EMAIL in .env (and USER_ROLES) to sign yourself in.
// Deployed: Cloudflare Access in front, verified on every request (src/auth).
// DEMO_MODE=1 runs on the Sep 2026 workbook balances instead of Xero.

require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { requireUser, requireCapability } = require('./src/auth/access');
const authRoutes = require('./src/routes/auth');
const api = require('./src/web/api');
const store = require('./src/store/store');

const IS_PROD = process.env.NODE_ENV === 'production';
const missing = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI', 'XERO_SCOPES'].filter((v) => !process.env[v]);
if (missing.length && process.env.DEMO_MODE !== '1') {
  console.error(`Missing in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in (see docs/SETUP.md).`);
  process.exit(1);
}
if (!process.env.USER_ROLES) {
  console.error('USER_ROLES is empty, so nobody can sign in. Add e.g. USER_ROLES=you@joinrora.com:admin to .env.');
  process.exit(1);
}

store.ensureSeeded();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
}));

app.get('/health', (req, res) => res.json({ ok: true, app: 'emperia-close' }));

app.use(requireUser());

// Writes must be JSON, and from this app when the browser says where from.
const PUBLIC_ORIGIN = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;
function sameOriginJson(req, res, next) {
  if (req.method === 'GET') return next();
  const origin = req.get('Origin');
  if (origin && PUBLIC_ORIGIN && origin !== PUBLIC_ORIGIN) return res.status(403).json({ error: 'Cross-site request refused.' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON only.' });
  return next();
}

app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 900, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.user.email }));

// Connecting Xero: admins only (plus AUTH_SETUP_TOKEN inside the router when set).
app.use('/auth', requireCapability('admin'), authRoutes);

app.use('/api', express.json({ limit: '100kb' }), sameOriginJson, api);
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: IS_PROD ? '1h' : 0 }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Emperia close dashboard on http://localhost:${port}${process.env.DEMO_MODE === '1' ? ' (DEMO_MODE: Sep 2026 workbook balances, no Xero)' : ''}`);
  console.log(`Data: ${store.DATA_DIR}`);
});
