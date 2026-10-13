import { describe, expect, it, vi } from 'vitest';
import { ConnectorError, createSafeHttp } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import type { FacebookConfig } from './config.js';
import { COMMENT_FIELDS, getComment, listComments, toNormalizedComment } from './comments.js';

const cfg: FacebookConfig = {
  appId: '111',
  appSecret: new Secret('APP-SECRET'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('v'.repeat(24)),
};
const now = () => Date.parse('2026-10-13T10:00:00Z');

function graph(routes: Record<string, (url: URL, init: RequestInit) => unknown>, status = 200) {
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    const key = `${init.method} ${url.pathname}`;
    const h = routes[key];
    if (!h) {
      return new Response(JSON.stringify({ error: { code: 100, error_subcode: 33 } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(h(url, init)), { status });
  });
  return {
    fetch,
    ctx: {
      accessToken: new Secret('PAGE-TOKEN'),
      externalAccountId: '900',
      http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: fetch as never }),
      signal: AbortSignal.timeout(1000),
      reportQuota: vi.fn(async () => undefined),
    },
  };
}

const REF = { sourceExternalId: '900_1', externalId: '900_1_7' };
const raw = (over: Record<string, unknown> = {}) => ({
  id: '900_1_7',
  message: 'hi',
  created_time: '2026-10-13T09:00:00+0000',
  from: { id: '42', name: 'Ann' },
  is_hidden: false,
  permalink_url: 'https://www.facebook.com/900/posts/1?comment_id=7',
  ...over,
});

describe('getComment', () => {
  it('normalizes a top-level comment', async () => {
    const { ctx } = graph({ 'GET /v26.0/900_1_7': () => raw() });
    expect(await getComment(cfg, now, ctx, REF)).toEqual({
      externalId: '900_1_7',
      sourceExternalId: '900_1',
      parentExternalId: null,
      author: { externalId: '42', displayName: 'Ann', profileUrl: null },
      body: 'hi',
      postedAt: new Date('2026-10-13T09:00:00Z'),
      platformState: 'visible',
      permalink: 'https://www.facebook.com/900/posts/1?comment_id=7',
    });
  });

  it('links a reply to its parent comment', async () => {
    const { ctx } = graph({
      'GET /v26.0/900_1_8': () => raw({ id: '900_1_8', parent: { id: '900_1_3' } }),
    });
    const c = await getComment(cfg, now, ctx, { sourceExternalId: '900_1', externalId: '900_1_8' });
    expect(c?.parentExternalId).toBe('900_1_3');
  });

  it('reports hidden comments as hidden', async () => {
    const { ctx } = graph({ 'GET /v26.0/900_1_7': () => raw({ is_hidden: true }) });
    expect((await getComment(cfg, now, ctx, REF))?.platformState).toBe('hidden');
  });

  it('handles missing author, missing message (sticker) and non-https permalink', async () => {
    const rest: Record<string, unknown> = raw();
    delete rest.from;
    delete rest.message;
    const { ctx } = graph({ 'GET /v26.0/900_1_7': () => ({ ...rest, permalink_url: 'http://x' }) });
    const c = await getComment(cfg, now, ctx, REF);
    expect(c?.author).toBeNull();
    expect(c?.body).toBe('');
    expect(c?.permalink).toBeNull();
  });

  it('returns null for a deleted comment (code 100/33)', async () => {
    const { ctx } = graph({});
    expect(await getComment(cfg, now, ctx, REF)).toBeNull();
  });

  it('rejects an unparseable comment body as a permanent error', async () => {
    const { ctx } = graph({ 'GET /v26.0/900_1_7': () => raw({ created_time: 'soon' }) });
    await expect(getComment(cfg, now, ctx, REF)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'invalid_graph_response',
    });
  });

  it('refuses a hostile id before any network I/O', async () => {
    const { ctx, fetch } = graph({});
    await expect(
      getComment(cfg, now, ctx, { sourceExternalId: '900_1', externalId: '../me/accounts' }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requests only the declared fields with a numeric id', async () => {
    const { ctx, fetch } = graph({ 'GET /v26.0/900_1_7': () => raw() });
    await getComment(cfg, now, ctx, REF);
    const url = fetch.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe('/v26.0/900_1_7');
    expect(url.searchParams.get('fields')).toBe(COMMENT_FIELDS);
    expect(url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain('PAGE-TOKEN');
  });
});

describe('listComments', () => {
  it('lists newest-first with the after cursor and never follows paging.next', async () => {
    const { ctx, fetch } = graph({
      'GET /v26.0/900_1/comments': () => ({
        data: [raw(), { id: '../bad', created_time: '2026-10-13T09:00:00+0000' }],
        paging: { cursors: { after: 'N2' }, next: 'https://evil.example/' },
      }),
    });
    const page = await listComments(cfg, now, ctx, {
      sourceExternalId: '900_1',
      cursor: 'CUR',
      limit: 25,
    });
    const url = fetch.mock.calls[0]![0] as URL;
    expect(url.searchParams.get('filter')).toBe('stream');
    expect(url.searchParams.get('order')).toBe('reverse_chronological');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('after')).toBe('CUR');
    expect(url.searchParams.get('fields')).toBe(COMMENT_FIELDS);
    expect(page.nextCursor).toBe('N2');
    expect(page.items.map((c) => c.externalId)).toEqual(['900_1_7']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0]![0])).hostname).toBe('graph.facebook.com');
  });

  it('ends paging when Graph gives no next link and omits after for the first page', async () => {
    const { ctx, fetch } = graph({
      'GET /v26.0/900_1/comments': () => ({ data: [raw()], paging: { cursors: { after: 'X' } } }),
    });
    const page = await listComments(cfg, now, ctx, {
      sourceExternalId: '900_1',
      cursor: null,
      limit: 10,
    });
    expect(page.nextCursor).toBeNull();
    expect((fetch.mock.calls[0]![0] as URL).searchParams.has('after')).toBe(false);
  });
});

describe('toNormalizedComment', () => {
  it('returns null for non-objects and bad ids', () => {
    expect(toNormalizedComment(null, '900_1')).toBeNull();
    expect(toNormalizedComment(raw({ id: '1?x=y' }), '900_1')).toBeNull();
  });
});
