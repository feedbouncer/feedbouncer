import { describe, expect, it } from 'vitest';
import { createSafeHttp } from '@feedbouncer/connectors';
import * as z from 'zod';
import { THREADS_API_HOST } from './config.js';
import { threadsPath, threadsRequest } from './api.js';

interface Scripted {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}
interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function scripted(responses: Scripted[]) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error('no scripted response');
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status,
      ...(r.headers && { headers: r.headers }),
    });
  };
  const call = {
    http: createSafeHttp({ allowedHosts: [THREADS_API_HOST], fetch }),
    signal: AbortSignal.timeout(2000),
  };
  return { call, sent };
}

describe('threadsRequest', () => {
  it('builds https://graph.threads.net/v1.0/<id>/conversation and sends the token only as a bearer header', async () => {
    const { call, sent } = scripted([{ status: 200, json: { data: [] } }]);
    await threadsRequest(
      { ...call, accessToken: 'tok' },
      {
        endpoint: 'conversation',
        id: '17890',
        method: 'GET',
        query: { reverse: 'true' },
        schema: z.object({ data: z.array(z.unknown()) }),
      },
    );
    expect(sent[0]!.url).toBe('https://graph.threads.net/v1.0/17890/conversation?reverse=true');
    expect(sent[0]!.headers.authorization).toBe('Bearer tok');
    expect(sent[0]!.url).not.toContain('tok');
  });

  it('returns the fbtrace id only when it is well formed', async () => {
    const ok = scripted([
      { status: 200, json: { data: [] }, headers: { 'x-fb-trace-id': 'Ab_1-x' } },
    ]);
    const schema = z.object({ data: z.array(z.unknown()) });
    const r = await threadsRequest(ok.call, { endpoint: 'me', method: 'GET', schema });
    expect(r.data).toEqual({ data: [] });
    expect(r.traceId).toBe('Ab_1-x');
    const bad = scripted([
      { status: 200, json: { data: [] }, headers: { 'x-fb-trace-id': 'a b/../c' } },
    ]);
    expect(
      (await threadsRequest(bad.call, { endpoint: 'me', method: 'GET', schema })).traceId,
    ).toBeNull();
  });

  it.each(['../me', '1/2', '1?x=1', '', 'abc', '1'.repeat(33)])(
    'threadsPath rejects id %j before any I/O',
    (id) =>
      expect(() => threadsPath('media', id)).toThrow(
        expect.objectContaining({ kind: 'permanent', code: 'invalid_request' }),
      ),
  );

  it('threadsPath requires an id where the table has one, and rejects a stray id', () => {
    expect(() => threadsPath('media')).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => threadsPath('me', '1')).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it.each([
    ['me', undefined, '/v1.0/me'],
    ['meThreads', undefined, '/v1.0/me/threads'],
    ['media', '12', '/v1.0/12'],
    ['conversation', '12', '/v1.0/12/conversation'],
    ['replies', '12', '/v1.0/12/replies'],
    ['manageReply', '12', '/v1.0/12/manage_reply'],
    ['createContainer', undefined, '/v1.0/me/threads'],
    ['publish', '12', '/v1.0/12/threads_publish'],
    ['publishingLimit', '12', '/v1.0/12/threads_publishing_limit'],
    ['oauthToken', undefined, '/oauth/access_token'],
    ['longLived', undefined, '/access_token'],
    ['refresh', undefined, '/refresh_access_token'],
    ['debugToken', undefined, '/v1.0/debug_token'],
  ] as const)('threadsPath %s', (endpoint, id, path) => {
    expect(threadsPath(endpoint, id)).toBe(path);
  });

  it('an error body never leaks message, url, token or secret', async () => {
    const { call } = scripted([
      {
        status: 400,
        json: { error: { message: 'client_secret=abc tok', code: 10, fbtrace_id: 'Ab_1' } },
      },
    ]);
    const err = await threadsRequest(
      { ...call, accessToken: 'tok' },
      {
        endpoint: 'longLived',
        method: 'GET',
        query: { client_secret: 'abc' },
        schema: z.object({}),
      },
    ).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err).toMatchObject({ kind: 'permanent', code: 'permission_denied' });
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toMatch(
      /abc|tok|client_secret|graph\.threads/,
    );
  });

  it('maps the error code and subcode and reads Retry-After', async () => {
    const { call } = scripted([
      {
        status: 400,
        json: { error: { code: 4, error_subcode: 2207051, message: 'x' } },
        headers: { 'retry-after': '30' },
      },
    ]);
    const err = await threadsRequest(call, {
      endpoint: 'publish',
      id: '1',
      method: 'POST',
      form: {},
      schema: z.object({}),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: 'rate_limited',
      code: 'reply_quota_exhausted',
      retryAfterMs: 30_000,
    });
  });

  it('reads an HTTP-date Retry-After against the injected clock', async () => {
    const { call } = scripted([
      {
        status: 429,
        json: { error: { code: 4 } },
        headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:30 GMT' },
      },
    ]);
    const now = () => Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    await expect(
      threadsRequest({ ...call, now }, { endpoint: 'me', method: 'GET', schema: z.object({}) }),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it('a non-JSON 5xx is transient, a non-JSON 200 is invalid_threads_response', async () => {
    const schema = z.object({});
    const a = scripted([{ status: 502, text: '<html>secret</html>' }]);
    await expect(
      threadsRequest(a.call, { endpoint: 'me', method: 'GET', schema }),
    ).rejects.toMatchObject({ kind: 'transient', code: 'threads_unavailable' });
    const b = scripted([{ status: 200, text: 'nope' }]);
    await expect(
      threadsRequest(b.call, { endpoint: 'me', method: 'GET', schema }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_threads_response' });
  });

  it('a 101-item page fails the schema as permanent/invalid_threads_response', async () => {
    const { call } = scripted([
      { status: 200, json: { data: Array.from({ length: 101 }, () => ({})) } },
    ]);
    await expect(
      threadsRequest(call, {
        endpoint: 'conversation',
        id: '1',
        method: 'GET',
        schema: z.object({ data: z.array(z.unknown()).max(100) }),
      }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_threads_response' });
  });

  it('POST sends application/x-www-form-urlencoded and nothing in the URL', async () => {
    const { call, sent } = scripted([{ status: 200, json: {} }]);
    await threadsRequest(
      { ...call, accessToken: 'tok' },
      {
        endpoint: 'manageReply',
        id: '55',
        method: 'POST',
        form: { hide: 'true' },
        schema: z.object({}),
      },
    );
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url).toBe('https://graph.threads.net/v1.0/55/manage_reply');
    expect(sent[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(sent[0]!.body).toBe('hide=true');
  });
});
