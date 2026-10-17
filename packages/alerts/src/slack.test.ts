import { describe, expect, it, vi } from 'vitest';
import { postSlack, slackHttp } from './slack.js';
import { renderSlackTest } from './render.js';

const HOOK = 'https://hooks.slack.com/services/TABC12345/BXYZ98765/sentinelHookSecret1234';
const NOW = Date.parse('2026-10-17T10:00:00.000Z');

const fake = (impl: () => Promise<Response>) => vi.fn<typeof fetch>(impl);
const respond = (status: number, body = '', headers: Record<string, string> = {}) =>
  fake(() => Promise.resolve(new Response(status === 204 ? null : body, { status, headers })));

const post = (f: typeof fetch, url = HOOK) =>
  postSlack(slackHttp(f), new URL(url), renderSlackTest(), () => NOW);

describe('postSlack', () => {
  it('200 ok → ok', async () => {
    const f = respond(200, 'ok');
    await expect(post(f)).resolves.toEqual({ ok: true });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(HOOK);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual(renderSlackTest());
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [404, 'no_service'],
    [410, 'channel_is_archived'],
    [403, 'action_prohibited'],
    [400, 'invalid_token'],
    [404, 'something_new'],
  ])('%i %s → revoked', async (status, body) => {
    await expect(post(respond(status, body))).resolves.toEqual({
      ok: false,
      kind: 'revoked',
      code: body,
    });
  });

  it('400 invalid_payload → invalid', async () => {
    await expect(post(respond(400, 'invalid_payload'))).resolves.toEqual({
      ok: false,
      kind: 'invalid',
      code: 'invalid_payload',
    });
  });

  it('429 Retry-After 30 → rate_limited 30000', async () => {
    await expect(post(respond(429, 'rate_limited', { 'retry-after': '30' }))).resolves.toEqual({
      ok: false,
      kind: 'rate_limited',
      code: 'rate_limited',
      retryAfterMs: 30_000,
    });
  });

  it('503 → transient', async () => {
    await expect(post(respond(503, ''))).resolves.toEqual({
      ok: false,
      kind: 'transient',
      code: 'http_503',
    });
  });

  it('fetch throws → transient network', async () => {
    const f = fake(() => Promise.reject(new TypeError(`fetch failed for ${HOOK}`)));
    await expect(post(f)).resolves.toEqual({ ok: false, kind: 'transient', code: 'network' });
  });

  it('timeout → transient timeout', async () => {
    const f = fake(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    await expect(post(f)).resolves.toEqual({ ok: false, kind: 'transient', code: 'timeout' });
  });

  it('3xx is invalid and not followed', async () => {
    const f = respond(302, '', { location: 'https://hooks.slack.com/services/elsewhere' });
    await expect(post(f)).resolves.toEqual({ ok: false, kind: 'invalid', code: 'http_302' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("body 'Some <html>' → code http_500", async () => {
    await expect(post(respond(500, 'Some <html>'))).resolves.toEqual({
      ok: false,
      kind: 'transient',
      code: 'http_500',
    });
  });

  it('treats an oversized body as transient without echoing it', async () => {
    const r = await post(respond(500, 'x'.repeat(5000)));
    expect(r).toEqual({ ok: false, kind: 'transient', code: 'response_too_large' });
  });

  it.each([
    'https://evil.test/services/TABC12345/BXYZ98765/sentinelHookSecret1234',
    'http://hooks.slack.com/services/TABC12345/BXYZ98765/sentinelHookSecret1234',
    'https://hooks.slack.com:8443/services/TABC12345/BXYZ98765/sentinelHookSecret1234',
    'https://hooks.slack.com/api/other',
  ])('a non-Slack URL is rejected before fetch (%s)', async (url) => {
    const f = respond(200, 'ok');
    const r = await post(f, url);
    expect(r).toEqual({ ok: false, kind: 'invalid', code: 'invalid_url' });
    expect(f).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('sentinel');
  });
});
