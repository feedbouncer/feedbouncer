import { afterEach, describe, expect, it } from 'vitest';
import { clientAddress, forwardToApi } from './api-proxy';

const API = new URL('http://api:3001');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(res: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return res();
  }) as typeof fetch;
  return calls;
}

describe('clientAddress', () => {
  it.each(['203.0.113.7', '::1', '::ffff:172.22.0.1', '2001:db8::5'])('accepts %s', (v) => {
    expect(clientAddress(v)).toBe(v);
  });
  it.each([null, '', '6.6.6.6, 203.0.113.7', 'evil', '203.0.113.7 ', 'unknown'])(
    'rejects %s',
    (v) => {
      expect(clientAddress(v)).toBeNull();
    },
  );
});

describe('forwardToApi', () => {
  it('forwards to the API with only the web-tier client address in X-Forwarded-For', async () => {
    const calls = stubFetch(() => Response.json({ status: 'ok' }));
    const req = new Request('http://localhost:3000/api/auth/sign-in/email?x=1', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        cookie: 'fb.session_token=abc',
        'content-type': 'application/json',
        // What Next leaves after proxy.ts removed the client's value: the socket address.
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-host': 'evil.test',
        'x-real-ip': '6.6.6.6',
        'x-fb-client-ip': '6.6.6.6',
        forwarded: 'for=6.6.6.6',
      },
      body: '{"email":"a@x.test"}',
    });
    const res = await forwardToApi(req, API);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api:3001/api/auth/sign-in/email?x=1');
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('origin')).toBe('http://localhost:3000');
    expect(sent.get('cookie')).toBe('fb.session_token=abc');
    expect(sent.get('content-type')).toBe('application/json');
    for (const h of ['x-forwarded-host', 'x-real-ip', 'x-fb-client-ip', 'forwarded', 'host']) {
      expect(sent.has(h), h).toBe(false);
    }
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('sends no X-Forwarded-For when the address is not a single IP', async () => {
    const calls = stubFetch(() => Response.json({}));
    const req = new Request('http://localhost:3000/api/v1/me', {
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
    });
    await forwardToApi(req, API);
    expect(new Headers(calls[0]!.init.headers).has('x-forwarded-for')).toBe(false);
  });

  it('passes status, Set-Cookie headers and redirects through unchanged', async () => {
    stubFetch(() => {
      const h = new Headers({ location: '/verified' });
      h.append('set-cookie', 'a=1; Path=/');
      h.append('set-cookie', 'b=2; Path=/');
      return new Response(null, { status: 302, headers: h });
    });
    const res = await forwardToApi(new Request('http://localhost:3000/api/auth/verify-email'), API);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/verified');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('forwards the public /v1 API with its bearer key and returns rate-limit headers unchanged', async () => {
    const calls = stubFetch(
      () =>
        new Response('{}', {
          status: 429,
          headers: { 'retry-after': '12', 'www-authenticate': 'Bearer realm="FeedBouncer API"' },
        }),
    );
    const req = new Request('http://localhost:3000/v1/comments?limit=5', {
      headers: { authorization: 'Bearer fbk_x', 'x-forwarded-for': '203.0.113.7' },
    });
    const res = await forwardToApi(req, API);
    expect(calls[0]!.url).toBe('http://api:3001/v1/comments?limit=5');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer fbk_x');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="FeedBouncer API"');
  });

  it('refuses paths outside /api/auth, /api/v1 and /v1 without calling the API', async () => {
    const calls = stubFetch(() => Response.json({}));
    const res = await forwardToApi(new Request('http://localhost:3000/healthz'), API);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('answers 502 temporarily_unavailable when the API cannot be reached', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const res = await forwardToApi(new Request('http://localhost:3000/api/v1/me'), API);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('temporarily_unavailable');
  });
});
