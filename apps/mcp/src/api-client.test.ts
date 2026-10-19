import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { ApiCallError, FeedBouncerApi } from './api-client.js';
import type { McpConfig } from './config.js';

const KEY = `fbk_abcdefghij234567_${'A'.repeat(43)}`;
const ID = '3f0c1a52-8d0e-4c43-9c63-0f4d3b1f2a10';
const cfg: McpConfig = {
  apiBaseUrl: new URL('http://127.0.0.1:3001'),
  apiKey: new Secret(KEY),
  requestTimeoutMs: 10_000,
  replyWaitMs: 15_000,
};

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const comment = {
  id: ID,
  brandId: ID,
  connectionId: ID,
  platform: 'facebook',
  externalId: 'e1',
  parentId: null,
  authorName: null,
  text: 'hello',
  textTruncated: false,
  postedAt: '2026-10-01T10:00:00.000Z',
  ingestedAt: '2026-10-01T10:00:05.000Z',
  status: 'visible',
  flagged: false,
  permalink: null,
  isOwnAccount: false,
  extraField: 'ignored',
};
const action = {
  id: ID,
  kind: 'public_reply',
  commentId: ID,
  status: 'pending',
  code: null,
  platformRef: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

function setup(res: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>(async () => res());
  return { api: new FeedBouncerApi(cfg, fetchImpl), fetchImpl };
}
const call = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, n = 0) => {
  const [url, init] = fetchImpl.mock.calls[n]!;
  return { url: new URL(String(url)), init: init as RequestInit };
};

describe('FeedBouncerApi requests', () => {
  it('sends auth, user agent, redirect:error and a timeout signal', async () => {
    const { api, fetchImpl } = setup(() => json({ organizationId: ID, name: 'k', scope: 'read' }));
    await expect(api.whoami()).resolves.toEqual({ organizationId: ID, name: 'k', scope: 'read' });
    const { url, init } = call(fetchImpl);
    expect(url.pathname).toBe('/v1/key');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('user-agent')).toMatch(/^feedbouncer-mcp\/\d/);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('lists comments with filters and cursor, stripping unknown fields', async () => {
    const { api, fetchImpl } = setup(() => json({ data: [comment], nextCursor: 'c2' }));
    const page = await api.listComments({ status: 'flagged', q: 'refund', limit: 5, cursor: 'c1' });
    expect(page.nextCursor).toBe('c2');
    expect(page.data[0]).not.toHaveProperty('extraField');
    const { url } = call(fetchImpl);
    expect(url.pathname).toBe('/v1/comments');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'flagged',
      q: 'refund',
      limit: '5',
      cursor: 'c1',
    });
  });

  it('rejects a non-UUID id before calling fetch', async () => {
    const { api, fetchImpl } = setup(() => json(action));
    await expect(api.getAction('../v1/key')).rejects.toBeInstanceOf(ApiCallError);
    await expect(api.reply('nope', 'hi', 'k1')).rejects.toBeInstanceOf(ApiCallError);
    await expect(api.setVisibility('nope', 'hidden', 'k1')).rejects.toBeInstanceOf(ApiCallError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a reply with an idempotency key and returns the status', async () => {
    const { api, fetchImpl } = setup(() => json({ action, comment }, { status: 202 }));
    const out = await api.reply(ID, 'thanks!', 'key-1');
    expect(out.status).toBe(202);
    expect(out.body.action.status).toBe('pending');
    const { url, init } = call(fetchImpl);
    expect(url.pathname).toBe(`/v1/comments/${ID}/replies`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('key-1');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'thanks!' });
  });

  it('hides and unhides via the moderation routes', async () => {
    const { api, fetchImpl } = setup(() =>
      json({ action: { id: ID, kind: 'hide', status: 'applied', code: null }, comment }),
    );
    await api.setVisibility(ID, 'hidden', 'k');
    await api.setVisibility(ID, 'visible', 'k');
    expect(call(fetchImpl, 0).url.pathname).toBe(`/v1/comments/${ID}/hide`);
    expect(call(fetchImpl, 1).url.pathname).toBe(`/v1/comments/${ID}/unhide`);
  });

  it('fetches summary and rules with their query params', async () => {
    const summary = {
      period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
      bounded: null,
      totals: { comments: 1, hidden: 0, replied: 0, unanswered: 1 },
      categories: [],
      topRules: [],
      notableThreads: [],
    };
    const { api, fetchImpl } = setup(() => json(summary));
    await api.summary({ from: '2026-10-01T00:00:00Z', brandId: ID });
    expect(Object.fromEntries(call(fetchImpl).url.searchParams)).toEqual({
      from: '2026-10-01T00:00:00Z',
      brandId: ID,
    });

    const rules = setup(() => json({ brands: [] }));
    await expect(rules.api.rules(ID)).resolves.toEqual({ brands: [] });
    expect(call(rules.fetchImpl).url.search).toBe(`?brandId=${ID}`);
  });

  it('proposes a rule change', async () => {
    const proposal = {
      id: ID,
      brandId: ID,
      operation: 'archive',
      ruleId: ID,
      status: 'pending',
      diff: [],
      warnings: [],
      expiresAt: '2026-10-08T00:00:00.000Z',
      baseRuleRevision: 3,
      reviewUrl: 'https://app.example.com/review/1',
    };
    const { api, fetchImpl } = setup(() => json(proposal, { status: 201 }));
    const out = await api.proposeRuleChange({ operation: 'archive', brandId: ID, ruleId: ID }, 'k');
    expect(out.status).toBe('pending');
    expect(call(fetchImpl).url.pathname).toBe('/v1/rule-change-proposals');
  });
});

describe('FeedBouncerApi errors', () => {
  it('maps a 429 with retry-after', async () => {
    const { api } = setup(() =>
      json(
        { error: { code: 'rate_limited', message: 'Slow down.' } },
        { status: 429, headers: { 'retry-after': '7' } },
      ),
    );
    await expect(api.whoami()).rejects.toMatchObject({
      name: 'ApiCallError',
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 7,
    });
  });

  it('keeps flat error extras as details', async () => {
    const { api } = setup(() =>
      json({ error: { code: 'text_too_long', message: 'Too long.', max: 2200 } }, { status: 422 }),
    );
    await expect(api.reply(ID, 'x', 'k')).rejects.toMatchObject({
      code: 'text_too_long',
      details: { max: 2200 },
    });
  });

  it('turns a redirect or network failure into an error without leaking the key', async () => {
    const { api } = setup(() => {
      throw new TypeError(`fetch failed ${KEY}`);
    });
    const err = await api.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(String(err)).not.toContain('fbk_');
    expect(JSON.stringify(err)).not.toContain('fbk_');
  });

  it('reports a malformed success body as bad_response', async () => {
    const { api } = setup(() => json({ organizationId: ID }));
    await expect(api.whoami()).rejects.toMatchObject({ status: 502, code: 'bad_response' });
  });

  it('reports a non-JSON error body with a generic code', async () => {
    const { api } = setup(() => new Response('<html>', { status: 502 }));
    await expect(api.whoami()).rejects.toMatchObject({ status: 502, code: 'bad_response' });
  });
});
