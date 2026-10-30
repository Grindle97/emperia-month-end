// Cloudflare Worker in front of the Emperia close dashboard on Railway.
//
// Cloudflare Access protects this Worker's address: nobody reaches it without
// signing in as an allow-listed email. Access then adds a signed token
// (Cf-Access-Jwt-Assertion) to the request, and this Worker forwards the
// request, token included, to Railway. The app verifies that token on every
// request, so the raw Railway address is useless on its own.
//
// Variable: ORIGIN = https://<service>.up.railway.app (no trailing slash)

export default {
  async fetch(request, env) {
    const origin = String(env.ORIGIN || '').replace(/\/+$/, '');
    if (!origin) return new Response('ORIGIN is not set on this Worker.', { status: 500 });

    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, origin);

    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', incoming.host);
    headers.set('X-Forwarded-Proto', 'https');

    const res = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });

    // Keep same-site redirects on this address rather than the Railway one.
    const out = new Response(res.body, res);
    const loc = res.headers.get('Location');
    if (loc && loc.startsWith(origin)) out.headers.set('Location', loc.replace(origin, `https://${incoming.host}`));
    return out;
  },
};
