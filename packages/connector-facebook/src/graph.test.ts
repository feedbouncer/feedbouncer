import { describe, expect, it, vi } from 'vitest';
import { ConnectorError, createSafeHttp } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import {
  appSecretProof,
  graphErrorCodes,
  graphId,
  graphRequest,
  mapGraphError,
  parseBucUsage,
} from './graph.js';

const kind = (e: ConnectorError) => `${e.kind}/${e.code}`;
const noUsage = { throttledForMs: null };

describe('graphId', () => {
  it.each(['123', '123_456', '900_1_7'])('accepts %s', (v) => expect(graphId(v)).toBe(v));
  it.each([
    '../me/accounts',
    '1?fields=access_token',
    '1#',
    '1/2',
    'https://evil.example/x',
    '',
    '1'.repeat(33),
    '1_2_3_4',
    'abc',
    '1_a',
    12,
    null,
  ])('rejects %s', (v) => {
    try {
      graphId(v);
      throw new Error('accepted');
    } catch (e) {
      expect(kind(e as ConnectorError)).toBe('permanent/invalid_graph_id');
    }
  });
});

function call(fetch: typeof globalThis.fetch) {
  return {
    http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch }),
    signal: AbortSignal.timeout(1000),
    version: 'v26.0',
    appSecret: new Secret('APP-SECRET'),
    token: new Secret('PAGE-TOKEN-SENTINEL'),
    nowMs: () => 1_700_000_000_000,
  };
}

describe('graphRequest', () => {
  it('sends the token only as a bearer header and a proof in the query', async () => {
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).not.toContain('PAGE-TOKEN-SENTINEL');
      expect(url.searchParams.get('appsecret_proof')).toBe(
        appSecretProof(new Secret('PAGE-TOKEN-SENTINEL'), new Secret('APP-SECRET')),
      );
      expect(url.pathname).toBe('/v26.0/123_456');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer PAGE-TOKEN-SENTINEL');
      expect(init.body).toBe('is_hidden=true');
      return new Response('{"success":true}', { status: 200 });
    });
    const r = await graphRequest(call(fetch as never), {
      method: 'POST',
      path: ['123_456'],
      form: { is_hidden: 'true' },
    });
    expect(r.body).toEqual({ success: true });
  });

  it('accepts a three-segment comment id in the path', async () => {
    const fetch = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe('/v26.0/900_1_7/comments');
      return new Response('{"data":[]}', { status: 200 });
    });
    await graphRequest(call(fetch as never), { method: 'GET', path: ['900_1_7', 'comments'] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([['../me'], ['1_2_3_4'], ['1?x=y'], ['1#'], ['https://evil.example/x'], ['unknown']])(
    'refuses a hostile path segment %s before any I/O',
    async (seg) => {
      const fetch = vi.fn();
      await expect(
        graphRequest(call(fetch as never), { method: 'GET', path: [seg!] }),
      ).rejects.toMatchObject({ code: 'invalid_graph_id' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('allows the replies segment and still rejects hostile ids', async () => {
    const fetch = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe('/v26.0/17890000000000001/replies');
      return new Response('{"data":[]}', { status: 200 });
    });
    await graphRequest(call(fetch as never), {
      method: 'GET',
      path: ['17890000000000001', 'replies'],
    });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(
      graphRequest(call(fetch as never), { method: 'GET', path: ['..', 'replies'] }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_graph_id' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('maps a Graph error body and never carries its message', async () => {
    const fetch = async () =>
      new Response(
        JSON.stringify({
          error: { message: 'token PAGE-TOKEN-SENTINEL bad', code: 190, error_subcode: 463 },
        }),
        { status: 400 },
      );
    const err = await graphRequest(call(fetch as never), { method: 'GET', path: ['me'] }).catch(
      (e: unknown) => e as ConnectorError,
    );
    expect(kind(err as ConnectorError)).toBe('auth_expired/token_expired');
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('SENTINEL');
    expect(graphErrorCodes(err as ConnectorError)).toEqual({ code: 190, subcode: 463 });
  });

  it('records null codes when the error body has none, and nothing for other errors', async () => {
    const fetch = async () => new Response('oops', { status: 503 });
    const err = await graphRequest(call(fetch as never), { method: 'GET', path: ['me'] }).catch(
      (e: unknown) => e as ConnectorError,
    );
    expect(graphErrorCodes(err as ConnectorError)).toEqual({ code: null, subcode: null });
    expect(graphErrorCodes(new ConnectorError('permanent', 'graph_error'))).toBeNull();
  });

  it('treats an empty 2xx body as transient', async () => {
    const fetch = async () => new Response('', { status: 200 });
    await expect(
      graphRequest(call(fetch as never), { method: 'GET', path: ['me'] }),
    ).rejects.toMatchObject({ kind: 'transient', code: 'platform_unavailable' });
  });
});

describe('mapGraphError', () => {
  it.each([
    [{ code: 190 }, 400, 'auth_expired/token_invalid'],
    [{ code: 190, error_subcode: 463 }, 400, 'auth_expired/token_expired'],
    [{ code: 190, error_subcode: 460 }, 400, 'auth_expired/password_changed'],
    [{ code: 190, error_subcode: 492 }, 400, 'auth_expired/page_role_lost'],
    [{ code: 102 }, 400, 'auth_expired/session_invalid'],
    [{ code: 4 }, 400, 'rate_limited/platform_throttled'],
    [{ code: 17 }, 400, 'rate_limited/platform_throttled'],
    [{ code: 32 }, 400, 'rate_limited/platform_throttled'],
    [{ code: 613 }, 400, 'rate_limited/platform_throttled'],
    [{ code: 80001 }, 400, 'rate_limited/platform_throttled'],
    [{ code: 100, error_subcode: 33 }, 400, 'not_found/object_missing'],
    [{ code: 10 }, 403, 'permanent/permission_denied'],
    [{ code: 200 }, 403, 'permanent/permission_denied'],
    [{ code: 283 }, 403, 'permanent/permission_denied'],
    [{ code: 368 }, 400, 'permanent/blocked_for_policy'],
    [{ code: 1 }, 500, 'transient/platform_unavailable'],
    [{ code: 2 }, 503, 'transient/platform_unavailable'],
    [{ code: 999, is_transient: true }, 400, 'transient/platform_unavailable'],
    [null, 502, 'transient/platform_unavailable'],
    [null, 429, 'rate_limited/platform_throttled'],
    [{ code: 100 }, 400, 'permanent/graph_error'],
  ])('%j / %i -> %s', (e, status, expected) => {
    expect(kind(mapGraphError(e as never, status, noUsage, null, 0))).toBe(expected);
  });

  it('takes retry-after from BUC usage, in minutes', () => {
    const usage = parseBucUsage(
      JSON.stringify({
        '1': [{ type: 'pages', call_count: 100, estimated_time_to_regain_access: 3 }],
      }),
    );
    expect(usage.throttledForMs).toBe(180_000);
    expect(mapGraphError({ code: 80001 }, 400, usage, null, 0).retryAfterMs).toBe(180_000);
  });

  it('falls back to Retry-After, then to null (runtime default)', () => {
    expect(mapGraphError(null, 429, noUsage, '7', 0).retryAfterMs).toBe(7000);
    expect(mapGraphError({ code: 4 }, 400, noUsage, null, 0).retryAfterMs).toBeNull();
  });

  it('parseBucUsage tolerates junk', () => {
    for (const h of [
      null,
      '',
      'not json',
      '[]',
      '{"1":"x"}',
      '{"1":[{"estimated_time_to_regain_access":-5}]}',
    ])
      expect(parseBucUsage(h).throttledForMs).toBeNull();
  });
});
