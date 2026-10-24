import { createSafeHttp } from '@feedbouncer/connectors';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TIKTOK_API_HOST } from './endpoints.js';
import { tiktokRequest } from './request.js';

interface Scripted {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}
interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function scripted(responses: Scripted[]) {
  const sent: Sent[] = [];
  const queue = [...responses];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init.body as string | undefined,
    });
    const r = queue.shift()!;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetch;
  const http = createSafeHttp({ allowedHosts: [TIKTOK_API_HOST], fetch: fetchFn });
  return { call: { http, signal: new AbortController().signal }, sent };
}

const ok = (data: unknown, extra: object = {}) => ({
  status: 200,
  json: { code: 0, message: 'OK', request_id: 'r1', data, ...extra },
});

describe('tiktokRequest', () => {
  it('builds https://business-api.tiktok.com/open_api/v1.3/<endpoint> and sends the token only as Access-Token', async () => {
    const { call, sent } = scripted([ok({ ok: true })]);
    const r = await tiktokRequest(
      { ...call, accessToken: 'tok' },
      {
        endpoint: 'adCommentList',
        method: 'GET',
        query: { advertiser_id: '1' },
        schema: z.object({ ok: z.boolean() }),
      },
    );
    expect(r).toEqual({ data: { ok: true }, requestId: 'r1' });
    expect(sent[0]!.url).toBe(
      'https://business-api.tiktok.com/open_api/v1.3/comment/list/?advertiser_id=1',
    );
    expect(sent[0]!.headers['access-token']).toBe('tok');
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  it('maps a non-zero envelope code without leaking message, url, token or secret', async () => {
    const { call } = scripted([
      {
        status: 200,
        json: { code: 40001, message: 'sEcReT=zq9 T0K3N-77', request_id: 'r2', data: {} },
      },
    ]);
    const err = await tiktokRequest(
      { ...call, accessToken: 'T0K3N-77' },
      {
        endpoint: 'adAdvertiserGet',
        method: 'GET',
        query: { secret: 'zq9' },
        schema: z.object({}),
      },
    ).catch((e) => e);
    expect(err).toMatchObject({ kind: 'permanent', code: 'permission_denied' });
    // The stack holds source file paths (which name this package), so only the data fields are checked for the URL host.
    expect(JSON.stringify({ ...err, message: err.message })).not.toMatch(
      /zq9|T0K3N|sEcReT|business-api|open_api/i,
    );
    expect(err.stack).not.toMatch(/zq9|T0K3N|sEcReT/i);
  });

  it('rejects an endpoint key that is not in the table before any I/O', async () => {
    const { call, sent } = scripted([]);
    await expect(
      tiktokRequest(call, { endpoint: '../me' as never, method: 'GET', schema: z.object({}) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      tiktokRequest(call, { endpoint: 'toString' as never, method: 'GET', schema: z.object({}) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(sent).toHaveLength(0);
  });

  it('a schema failure is permanent/invalid_tiktok_response; an oversize array fails the schema', async () => {
    const { call } = scripted([ok({ items: Array(501).fill(1) })]);
    await expect(
      tiktokRequest(call, {
        endpoint: 'adCommentList',
        method: 'GET',
        schema: z.object({ items: z.array(z.number()).max(500) }),
      }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_tiktok_response' });
  });

  it('HTTP 429 with Retry-After becomes rate_limited with retryAfterMs', async () => {
    const { call } = scripted([{ status: 429, headers: { 'retry-after': '7' }, json: {} }]);
    await expect(
      tiktokRequest(call, { endpoint: 'adCommentList', method: 'GET', schema: z.object({}) }),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
  });

  it('non-JSON is transient on 5xx and permanent otherwise', async () => {
    const a = scripted([{ status: 502, text: '<html>' }]);
    await expect(
      tiktokRequest(a.call, { endpoint: 'adCommentList', method: 'GET', schema: z.object({}) }),
    ).rejects.toMatchObject({ kind: 'transient', code: 'tiktok_unavailable' });
    const b = scripted([{ status: 200, text: 'nope' }]);
    await expect(
      tiktokRequest(b.call, { endpoint: 'adCommentList', method: 'GET', schema: z.object({}) }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_tiktok_response' });
  });

  it('POST sends a JSON body and never puts body fields in the URL', async () => {
    const { call, sent } = scripted([ok({})]);
    await tiktokRequest(
      { ...call, accessToken: 'tok' },
      {
        endpoint: 'adCommentPost',
        method: 'POST',
        body: { advertiser_id: '1', text: 'hi' },
        schema: z.object({}),
      },
    );
    expect(sent[0]!.url).not.toContain('?');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent[0]!.body!)).toEqual({ advertiser_id: '1', text: 'hi' });
  });

  it('an invalid request_id is dropped to null', async () => {
    const { call } = scripted([ok({}, { request_id: 'a b<script>' })]);
    const r = await tiktokRequest(call, {
      endpoint: 'adCommentList',
      method: 'GET',
      schema: z.object({}),
    });
    expect(r.requestId).toBeNull();
  });
});
