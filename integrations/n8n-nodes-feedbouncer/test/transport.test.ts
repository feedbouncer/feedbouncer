import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureOperationSupported, feedBouncerRequest } from '../nodes/shared/transport';
import type { FbRequest } from '../nodes/shared/transport';
import { API_KEY, DEFAULT_CREDENTIALS, fakeExecute, fakeHook, slept } from './fakes';
import type { Scripted } from './fakes';

vi.mock('n8n-workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('n8n-workflow')>();
  return {
    ...actual,
    sleep: async (ms: number) => {
      (await import('./fakes')).slept.push(ms);
    },
  };
});

const ok = (body: unknown = { data: [] }): Scripted => ({ status: 200, body });
const envelope = (code: string, message = 'boom'): unknown => ({ error: { code, message } });
const get: FbRequest = { method: 'GET', path: '/v1/comments', operationId: 'listComments' };
const openApi = (...ids: string[]): Scripted =>
  ok({ paths: { '/v1/x': { get: { operationId: ids[0] }, post: { operationId: ids[1] ?? 'other' } } } });

async function failure(req: FbRequest, http: Scripted[], credentials = DEFAULT_CREDENTIALS) {
  const ctx = fakeExecute({ http, credentials });
  const error = await feedBouncerRequest(ctx, req).catch((e: unknown) => e);
  return { ctx, error: error as NodeApiError };
}

beforeEach(() => {
  slept.length = 0;
});

describe('request building', () => {
  it('builds base + path with a path prefix', async () => {
    const ctx = fakeExecute({ http: [ok()], credentials: { ...DEFAULT_CREDENTIALS, baseUrl: 'https://fb.acme.io/fb/' } });
    await feedBouncerRequest(ctx, { ...get, qs: { limit: 5 } });
    expect(ctx.calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://fb.acme.io/fb/v1/comments',
      qs: { limit: 5 },
      authenticated: true,
    });
    expect(ctx.calls[0].headers['User-Agent']).toMatch(/^n8n-nodes-feedbouncer\/\d+\.\d+\.\d+/);
  });

  it('sends Idempotency-Key and the redirect, timeout and SSL options', async () => {
    const ctx = fakeExecute({ http: [ok()], credentials: { ...DEFAULT_CREDENTIALS, allowUnauthorizedCerts: true } });
    await feedBouncerRequest(ctx, { ...get, method: 'POST', body: { a: 1 }, idempotencyKey: 'k.1' });
    expect(ctx.calls[0].headers['Idempotency-Key']).toBe('k.1');
    expect(ctx.calls[0].body).toEqual({ a: 1 });
    expect(ctx.calls[0].options).toMatchObject({
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      disableFollowRedirect: true,
      timeout: 30000,
      skipSslCertificateValidation: true,
    });
  });

  it('omits Idempotency-Key when none is given', async () => {
    const ctx = fakeExecute({ http: [ok()] });
    await feedBouncerRequest(ctx, get);
    expect(ctx.calls[0].headers).not.toHaveProperty('Idempotency-Key');
  });

  it('returns status, body and lower-cased headers', async () => {
    const ctx = fakeExecute({ http: [{ status: 200, body: { data: [1] }, headers: { 'X-Thing': 'a' } }] });
    expect(await feedBouncerRequest(ctx, get)).toEqual({ status: 200, body: { data: [1] }, headers: { 'x-thing': 'a' } });
  });

  it('works from a hook context', async () => {
    const ctx = fakeHook({ http: [ok()] });
    await expect(feedBouncerRequest(ctx, get)).resolves.toMatchObject({ status: 200 });
  });

  it('rejects an unusable base URL without echoing it', async () => {
    const { error } = await failure(get, [], { ...DEFAULT_CREDENTIALS, baseUrl: 'http://u:pw@fb.acme.io' });
    expect(error).toBeInstanceOf(NodeOperationError);
    expect(error.message).not.toContain('pw');
  });

  it('turns a credential read failure into a fixed message', async () => {
    const { error } = await failure(get, [], null as never);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect(error.message).toBe('FeedBouncer credentials are missing. Select a FeedBouncer API credential.');
  });

  it('skips authentication when auth is false', async () => {
    const ctx = fakeExecute({ http: [ok()] });
    await feedBouncerRequest(ctx, { ...get, auth: false });
    expect(ctx.calls[0].authenticated).toBe(false);
  });
});

describe('429 handling', () => {
  it('retries once after Retry-After 2', async () => {
    const ctx = fakeExecute({ http: [{ status: 429, headers: { 'Retry-After': '2' } }, ok()] });
    await expect(feedBouncerRequest(ctx, get)).resolves.toMatchObject({ status: 200 });
    expect(ctx.calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  it('backs off 1s, 2s, 4s without Retry-After, then throws the rate-limit error', async () => {
    const { ctx, error } = await failure(get, Array.from({ length: 4 }, () => ({ status: 429, body: envelope('rate_limited') })));
    expect(ctx.calls).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(error).toBeInstanceOf(NodeApiError);
    expect(error.message).toBe('FeedBouncer rate limit reached.');
    expect(error.httpCode).toBe('429');
  });

  it('throws at once when Retry-After is above 60', async () => {
    const { ctx, error } = await failure(get, [{ status: 429, headers: { 'retry-after': '120' } }]);
    expect(ctx.calls).toHaveLength(1);
    expect(slept).toEqual([]);
    expect(error.message).toBe('FeedBouncer rate limit reached.');
    expect(error.description).toContain('Retry after 120 seconds');
  });

  it('ignores a Retry-After it cannot read', async () => {
    const ctx = fakeExecute({ http: [{ status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }, ok()] });
    await feedBouncerRequest(ctx, get);
    expect(slept).toEqual([1000]);
  });
});

describe('error mapping', () => {
  it('maps 404 with an envelope to not-found without fetching the OpenAPI document', async () => {
    const { ctx, error } = await failure({ ...get, resourceLabel: 'comment', id: 'abc' }, [
      { status: 404, body: envelope('not_found') },
    ]);
    expect(error.message).toBe('No comment with ID abc in this FeedBouncer workspace.');
    expect(ctx.calls).toHaveLength(1);
  });

  it('maps a plain 404 to the version message when the server lacks the operation', async () => {
    const { ctx, error } = await failure(get, [{ status: 404, body: 'Not Found' }, openApi('getComment')]);
    expect(error.message).toBe('This FeedBouncer server does not support this operation yet.');
    expect(ctx.calls[1]).toMatchObject({ url: 'https://fb.acme.io/v1/openapi.json', authenticated: false });
  });

  it('maps a plain 404 to unexpected-response when the server has the operation', async () => {
    const { error } = await failure(get, [{ status: 404, body: 'Not Found' }, openApi('listComments')]);
    expect(error.message).toBe('FeedBouncer returned an unexpected response (HTTP 404).');
  });

  it('maps 302 to the redirect message', async () => {
    const { error } = await failure(get, [{ status: 302, headers: { location: 'https://evil.example/login' } }]);
    expect(error.message).toBe('FeedBouncer redirected the request.');
  });

  it('maps a 502 HTML body to an unexpected response', async () => {
    const { error } = await failure(get, [{ status: 502, body: '<html>Bad gateway</html>', headers: { 'content-type': 'text/html' } }]);
    expect(error.message).toBe('FeedBouncer returned an unexpected response (HTTP 502).');
  });

  it('maps ENOTFOUND to a host-only message', async () => {
    const { error } = await failure(get, [{ throw: { code: 'ENOTFOUND' } }], {
      ...DEFAULT_CREDENTIALS,
      baseUrl: 'https://fb.acme.io/some/path',
    });
    expect(error.message).toBe('Could not reach FeedBouncer at fb.acme.io.');
  });

  it('maps DEPTH_ZERO_SELF_SIGNED_CERT to the TLS message', async () => {
    const { error } = await failure(get, [{ throw: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }]);
    expect(error.message).toBe("FeedBouncer's TLS certificate was not accepted.");
  });

  it('names the credential from the node, falling back to the default', async () => {
    const ctx = fakeExecute({ http: [{ status: 401, body: envelope('unauthorized') }], credentialName: 'Prod key' });
    await expect(feedBouncerRequest(ctx, get)).rejects.toThrow('credential "Prod key"');
  });

  it('carries the item index', async () => {
    const ctx = fakeExecute({ http: [{ status: 401 }] });
    const error = (await feedBouncerRequest(ctx, { ...get, itemIndex: 4 }).catch((e: unknown) => e)) as NodeApiError;
    expect(JSON.stringify(error.context)).toContain('4');
  });
});

describe('ensureOperationSupported', () => {
  it('reads operation ids from the OpenAPI document and memoises per context', async () => {
    const ctx = fakeExecute({ http: [openApi('listComments', 'hideComment')] });
    expect(await ensureOperationSupported(ctx, 'hideComment')).toBe(true);
    expect(await ensureOperationSupported(ctx, 'getAction')).toBe(false);
    expect(ctx.calls).toHaveLength(1);
  });

  it('assumes support when the document cannot be read', async () => {
    const ctx = fakeExecute({ http: [{ status: 500, body: 'oops' }] });
    expect(await ensureOperationSupported(ctx, 'hideComment')).toBe(true);
  });
});

describe('secrets', () => {
  const leaks = (value: unknown) => JSON.stringify(value) + String((value as Error).stack) + String((value as Error).message);
  const rows: Array<[string, Scripted[]]> = [
    ['401', [{ status: 401, body: envelope('unauthorized', `bad key ${API_KEY}`) }]],
    ['403', [{ status: 403, body: envelope('insufficient_scope') }]],
    ['404 envelope', [{ status: 404, body: envelope('not_found') }]],
    ['404 version', [{ status: 404, body: 'x' }, openApi('getComment')]],
    ['404 unexpected', [{ status: 404, body: 'x' }, openApi('listComments')]],
    ['400 echoing the key', [{ status: 400, body: envelope('invalid_request', `Authorization: Bearer ${API_KEY}`) }]],
    ['429', [{ status: 429, headers: { 'retry-after': '99' }, body: envelope('rate_limited') }]],
    ['302', [{ status: 302, headers: { location: `https://x.example/?k=${API_KEY}` } }]],
    ['502', [{ status: 502, body: `<html>${API_KEY}</html>` }]],
    ['ENOTFOUND', [{ throw: { code: 'ENOTFOUND' } }]],
    ['ECONNREFUSED', [{ throw: { code: 'ECONNREFUSED' } }]],
    ['ETIMEDOUT', [{ throw: { code: 'ETIMEDOUT' } }]],
    ['TLS', [{ throw: { code: 'CERT_HAS_EXPIRED' } }]],
    ['unknown network error', [{ throw: { code: 'ECONNRESET' } }]],
  ];

  it.each(rows)('error for %s never contains the API key', async (_name, http) => {
    const { error } = await failure(get, http);
    expect(error).toBeInstanceOf(NodeApiError);
    const dump = leaks(error);
    expect(dump).not.toContain('AAAAAAAA');
    expect(dump).not.toContain('fbk_');
    expect(dump).not.toContain('Bearer');
    expect(error.cause).toBeUndefined();
  });

  it('does not leak when the OpenAPI lookup itself fails with a leaky error', async () => {
    const { error } = await failure(get, [{ status: 404, body: 'x' }, { throw: { code: 'ECONNRESET' } }]);
    expect(leaks(error)).not.toContain('AAAAAAAA');
  });
});
