import { afterEach, describe, expect, it } from 'vitest';
import { ApiRequestError, apiFetch } from './api-client';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(res: Response): { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return res;
  }) as typeof fetch;
  return { calls };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiFetch', () => {
  it('maps the error envelope to ApiRequestError and sends JSON same-origin', async () => {
    const { calls } = stubFetch(json({ error: { code: 'last_owner', message: 'm' } }, 409));
    const err = await apiFetch('/api/v1/orgs/x/members/y', { method: 'DELETE' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 409, code: 'last_owner' });
    expect(calls[0]![1].credentials).toBe('same-origin');
    expect((calls[0]![1].headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(calls[0]![1].body).toBe('{}');
  });

  it('returns parsed JSON and serializes the body', async () => {
    const { calls } = stubFetch(json({ ok: 1 }, 200));
    await expect(apiFetch('/api/v1/x', { method: 'POST', body: { a: 1 } })).resolves.toEqual({
      ok: 1,
    });
    expect(calls[0]![1].body).toBe('{"a":1}');
  });

  it('returns undefined for 204', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(apiFetch('/api/v1/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('falls back to internal_error for a non-envelope failure', async () => {
    stubFetch(new Response('boom', { status: 502 }));
    await expect(apiFetch('/api/v1/x')).rejects.toMatchObject({
      status: 502,
      code: 'internal_error',
    });
  });
});

describe('apiFetch error details', () => {
  it('exposes the numeric max of a text_too_long refusal', async () => {
    stubFetch(json({ error: { code: 'text_too_long', message: 'm', max: 2200 } }, 422));
    await expect(apiFetch('/api/v1/x', { method: 'POST' })).rejects.toMatchObject({
      status: 422,
      code: 'text_too_long',
      max: 2200,
    });
  });
  it('ignores a non-numeric max', async () => {
    stubFetch(json({ error: { code: 'text_too_long', message: 'm', max: '9' } }, 422));
    const err = (await apiFetch('/api/v1/x', { method: 'POST' }).catch((e: unknown) => e)) as {
      max?: unknown;
    };
    expect(err.max).toBeUndefined();
  });
});
