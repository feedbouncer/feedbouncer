// Forwards the browser-facing /api/auth/* and /api/v1/* paths to the API.
//
// The API's per-IP rate limits read the client address from X-Forwarded-For
// (TRUST_PROXY_HOPS=1: this server is the one trusted hop). A next.config
// rewrite cannot provide it: Next proxies rewrites without adding the header
// and passes the client's own value through, so the API would see either this
// server's address for everyone or an address the client chose. Instead,
// src/proxy.ts deletes every client-supplied forwarding header, Next then sets
// X-Forwarded-For to the TCP peer of this server, and only that single address
// is forwarded here.
import { isIP } from 'node:net';

const PREFIXES = ['/api/auth/', '/api/v1/'];
const TIMEOUT_MS = 30_000;

// Never forwarded upstream: hop-by-hop headers, anything that claims a client
// address or original host, and Next's internal headers.
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'content-length',
  'forwarded',
  'x-real-ip',
  'x-fb-client-ip',
]);
const DROP_REQUEST_PREFIXES = ['x-forwarded-', 'x-middleware-', 'x-invoke-', 'next-'];
// fetch already decoded the body, so its length and encoding no longer apply.
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie',
]);

/** The address to forward: only a single, well-formed IP, never a list. */
export function clientAddress(value: string | null): string | null {
  return value !== null && isIP(value) !== 0 ? value : null;
}

const unavailable = () =>
  Response.json(
    {
      error: {
        code: 'temporarily_unavailable',
        message: 'Temporarily unavailable. Try again shortly.',
      },
    },
    { status: 502, headers: { 'cache-control': 'no-store' } },
  );

export async function forwardToApi(req: Request, api: URL): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, api);
  if (target.origin !== api.origin || !PREFIXES.some((p) => target.pathname.startsWith(p))) {
    return Response.json(
      { error: { code: 'not_found', message: 'Not found.' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }

  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (DROP_REQUEST.has(name) || DROP_REQUEST_PREFIXES.some((p) => name.startsWith(p))) continue;
    headers.set(name, value);
  }
  const client = clientAddress(req.headers.get('x-forwarded-for'));
  if (client) headers.set('x-forwarded-for', client);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
    } as RequestInit);
  } catch (err) {
    // Never the URL: verification links carry their token in the query string.
    console.error('api proxy: upstream request failed', {
      path: target.pathname,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return unavailable();
  }

  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE.has(name)) out.append(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
