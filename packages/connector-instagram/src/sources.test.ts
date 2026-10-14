import { describe, expect, it } from 'vitest';
import { createSafeHttp, type CallContext } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import type { InstagramConfig } from './config.js';
import { listRecentMedia } from './sources.js';

const DAY = 86_400_000;
const APP_SECRET = 's'.repeat(32);
const cfg: InstagramConfig = {
  meta: {
    appId: '1234567',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  },
};

const setup = () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const g = new FakeGraph({ appSecret: APP_SECRET, appId: cfg.meta.appId, clock: () => now });
  const { userId } = g.addUser();
  const { pageId, pageToken } = g.addPage(userId);
  const { igUserId } = g.addInstagramAccount(pageId);
  const urls: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    urls.push(new URL(String(input instanceof Request ? input.url : input)));
    return g.fetch(input, init);
  };
  const ctx: CallContext = {
    accessToken: new Secret(pageToken),
    externalAccountId: igUserId,
    http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch }),
    signal: AbortSignal.timeout(2000),
    reportQuota: async () => undefined,
  };
  return { now, g, igUserId, ctx, urls };
};

describe('listRecentMedia', () => {
  it('returns in-window media newest first, never sends since, stops past since', async () => {
    const { now, g, igUserId, ctx, urls } = setup();
    const a = g.addIgMedia(igUserId, { createdAtMs: now - 2 * DAY }).mediaId;
    const b = g.addIgMedia(igUserId, { createdAtMs: now - DAY }).mediaId;
    g.addIgMedia(igUserId, { createdAtMs: now - 60 * DAY });
    const page = await listRecentMedia(cfg, () => now, ctx, { since: new Date(now - 30 * DAY), cursor: null, limit: 100 });
    expect(page.items.map((m) => m.externalId)).toEqual([b, a]);
    expect(page.nextCursor).toBeNull();
    const media = urls.filter((u) => u.pathname.endsWith('/media'));
    expect(media.length).toBe(1);
    expect(media.some((u) => u.searchParams.has('since'))).toBe(false);
    expect(media.some((u) => u.searchParams.has('access_token'))).toBe(false);
  });

  it('pages with after cursors', async () => {
    const { now, g, igUserId, ctx } = setup();
    const ids = [1, 2, 3].map((d) => g.addIgMedia(igUserId, { createdAtMs: now - d * DAY }).mediaId);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p = await listRecentMedia(cfg, () => now, ctx, { since: new Date(now - 30 * DAY), cursor, limit: 2 });
      seen.push(...p.items.map((m) => m.externalId));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
  });

  it('rejects a Facebook time cursor', async () => {
    const { now, ctx } = setup();
    await expect(listRecentMedia(cfg, () => now, ctx, { since: new Date(now - DAY), cursor: 'u:1760400000', limit: 10 }))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('a refused media list means the account permission is gone', async () => {
    const { now, g, ctx } = setup();
    g.failNextFor('/media', 200);
    await expect(listRecentMedia(cfg, () => now, ctx, { since: new Date(now - DAY), cursor: null, limit: 10 }))
      .rejects.toMatchObject({ kind: 'auth_expired', code: 'permission_revoked' });
  });
});
