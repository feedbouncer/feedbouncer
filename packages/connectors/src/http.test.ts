import { describe, expect, it, vi } from 'vitest';
import { ConnectorError } from './errors.js';
import { assertAllowedUrl, createSafeHttp, parseRetryAfter } from './http.js';

const HOSTS = ['graph.example.test'];
const kindOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ConnectorError ? `${e.kind}/${e.code}` : 'other';
  }
  return 'ok';
};

describe('assertAllowedUrl (Review Focus 2)', () => {
  it('accepts https on an allowed host', () => {
    expect(assertAllowedUrl('https://graph.example.test/v1/c?after=x', HOSTS).hostname).toBe(
      'graph.example.test',
    );
  });
  it.each([
    'http://graph.example.test/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://evil.example/v1',
    'https://graph.example.test@evil.example/v1',
    'https://user:pw@graph.example.test/v1',
    'https://graph.example.test:8443/v1',
    'https://graph.example.test.evil.example/v1',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (url) => {
    expect(kindOf(() => assertAllowedUrl(url, HOSTS))).toBe('permanent/disallowed_url');
  });
});

describe('createSafeHttp', () => {
  const GET = { method: 'GET', url: 'https://graph.example.test/' } as const;

  it('never calls fetch for a disallowed url', async () => {
    const fetch = vi.fn();
    const http = createSafeHttp({ allowedHosts: HOSTS, fetch });
    await expect(
      http.request({ method: 'GET', url: 'https://evil.example/' }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: 'disallowed_url' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not follow redirects', async () => {
    const fetch = vi.fn(async (_u: URL, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    });
    const http = createSafeHttp({
      allowedHosts: HOSTS,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const res = await http.request(GET, AbortSignal.timeout(1000));
    expect(res.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns status, headers and body for a normal response', async () => {
    const fetch = async () => new Response('{"ok":true}', { headers: { 'x-a': 'b' } });
    const http = createSafeHttp({
      allowedHosts: HOSTS,
      fetch: fetch as typeof globalThis.fetch,
    });
    const res = await http.request(GET, AbortSignal.timeout(1000));
    expect(res).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(res.headers.get('x-a')).toBe('b');
  });

  it('caps response size', async () => {
    const fetch = async () => new Response('x'.repeat(2048));
    const http = createSafeHttp({
      allowedHosts: HOSTS,
      fetch: fetch as typeof globalThis.fetch,
      maxResponseBytes: 1024,
    });
    await expect(http.request(GET, AbortSignal.timeout(1000))).rejects.toMatchObject({
      kind: 'permanent',
      code: 'response_too_large',
    });
  });

  it('maps network failures to transient without leaking the message', async () => {
    const fetch = async () => {
      throw new TypeError('connect ECONNREFUSED https://graph.example.test/?access_token=SENTINEL');
    };
    const http = createSafeHttp({
      allowedHosts: HOSTS,
      fetch: fetch as typeof globalThis.fetch,
    });
    const err = await http.request(GET, AbortSignal.timeout(1000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(JSON.stringify(err) + String(err)).not.toContain('SENTINEL');
    expect((err as ConnectorError).kind).toBe('transient');
  });

  it('maps aborts to a transient timeout', async () => {
    const fetch = async () => {
      throw new DOMException('aborted', 'TimeoutError');
    };
    const http = createSafeHttp({
      allowedHosts: HOSTS,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(http.request(GET, AbortSignal.timeout(1000))).rejects.toMatchObject({
      kind: 'transient',
      code: 'timeout',
    });
  });
});

describe('createSafeHttp body read failures', () => {
  const GET = { method: 'GET', url: 'https://graph.example.test/' } as const;
  const enc = new TextEncoder();

  it('maps a mid-stream error to transient/network_error without leaking the message', async () => {
    const fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('partial'));
            c.error(new TypeError('terminated https://graph.example.test/?access_token=SENTINEL'));
          },
        }),
      );
    const http = createSafeHttp({ allowedHosts: HOSTS, fetch: fetch as typeof globalThis.fetch });
    const err = await http.request(GET, AbortSignal.timeout(1000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(JSON.stringify(err) + String(err)).not.toContain('SENTINEL');
    expect(err).toMatchObject({ kind: 'transient', code: 'network_error' });
  });

  it('maps a signal aborted mid-body to transient/timeout', async () => {
    const ac = new AbortController();
    const fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('partial'));
            ac.abort();
            c.error(new DOMException('aborted', 'AbortError'));
          },
        }),
      );
    const http = createSafeHttp({ allowedHosts: HOSTS, fetch: fetch as typeof globalThis.fetch });
    await expect(http.request(GET, ac.signal)).rejects.toMatchObject({
      kind: 'transient',
      code: 'timeout',
    });
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  it('parses delta seconds', () => expect(parseRetryAfter('30', now)).toBe(30_000));
  it('parses HTTP dates', () =>
    expect(parseRetryAfter('Mon, 12 Oct 2026 00:01:00 GMT', now)).toBe(60_000));
  it('clamps past dates to 0', () =>
    expect(parseRetryAfter('Sun, 11 Oct 2026 00:00:00 GMT', now)).toBe(0));
  it('caps at 24h', () => expect(parseRetryAfter('999999999', now)).toBe(86_400_000));
  it.each([null, '', 'soon', '-5', '1.5'])('returns null for %s', (v) =>
    expect(parseRetryAfter(v, now)).toBeNull(),
  );
});
