import { describe, expect, it } from 'vitest';
import { world } from './test-world.js';

const since = new Date('2026-10-01T00:00:00Z');
const until = new Date('2026-10-24T00:00:00Z');
const at = (iso: string) => new Date(iso);

async function seeded() {
  const w = await world();
  const { fake, advertiserId } = w;
  const top = fake.addAdComment(advertiserId, {
    adId: '111',
    itemId: '900',
    text: 'first',
    createdAt: at('2026-10-10T08:00:00Z'),
  });
  fake.addAdComment(advertiserId, {
    adId: '111',
    itemId: '900',
    text: 'reply',
    createdAt: at('2026-10-11T08:00:00Z'),
    parentId: top.commentId,
  });
  fake.addAdComment(advertiserId, {
    adId: '222',
    itemId: '901',
    text: 'other ad',
    createdAt: at('2026-10-12T08:00:00Z'),
    hidden: true,
  });
  return { ...w, top };
}
const list = (
  w: Awaited<ReturnType<typeof seeded>>,
  o: { page?: number; pageSize?: number } = {},
) =>
  w.connector.listConnectionComments!(w.ctx, {
    since,
    until,
    page: o.page ?? 1,
    pageSize: o.pageSize ?? 50,
  });

describe('listConnectionComments', () => {
  it('lists advertiser comments newest first with ad sources, flat replies and parents', async () => {
    const w = await seeded();
    const page = await list(w);
    expect(
      page.items.map((c) => [c.body, c.sourceExternalId, c.parentExternalId, c.platformState]),
    ).toEqual([
      ['other ad', '222', null, 'hidden'],
      ['reply', '111', w.top.commentId, 'visible'],
      ['first', '111', null, 'visible'],
    ]);
    expect(page.items[2]).toMatchObject({
      externalId: w.top.commentId,
      postedAt: at('2026-10-10T08:00:00Z'),
      permalink: null,
    });
    expect(page.sources).toEqual([
      {
        externalId: '222',
        kind: 'ad_post',
        permalink: 'https://www.tiktok.com/@/video/901',
        active: true,
      },
      {
        externalId: '111',
        kind: 'ad_post',
        permalink: 'https://www.tiktok.com/@/video/900',
        active: true,
      },
    ]);
    expect(page.hasMore).toBe(false);
    expect(w.fake.calls('adCommentList')[0]!.query).toMatchObject({
      advertiser_id: w.advertiserId,
      search_field: 'ADVERTISER_ID',
      search_value: w.advertiserId,
      start_time: '2026-10-01',
      end_time: '2026-10-24',
      sort_field: 'CREATE_TIME',
      sort_type: 'DESC',
      comment_type: '["ALL"]',
      page: '1',
      page_size: '50',
    });
  });

  it('a window wider than 30 days is rejected before I/O', async () => {
    const w = await seeded();
    await expect(
      w.connector.listConnectionComments!(w.ctx, {
        since: at('2026-09-01T00:00:00Z'),
        until,
        page: 1,
        pageSize: 50,
      }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_request' });
    expect(w.fake.calls('adCommentList')).toHaveLength(0);
  });

  it.each([
    { page: 0, pageSize: 50 },
    { page: 100_001, pageSize: 50 },
    { page: 1.5, pageSize: 50 },
    { page: 1, pageSize: 0 },
    { page: 1, pageSize: 101 },
  ])('refuses %j before I/O', async (r) => {
    const w = await seeded();
    await expect(
      w.connector.listConnectionComments!(w.ctx, { since, until, ...r }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(w.fake.calls('adCommentList')).toHaveLength(0);
  });

  it('a reversed window is refused before I/O', async () => {
    const w = await seeded();
    await expect(
      w.connector.listConnectionComments!(w.ctx, {
        since: until,
        until: since,
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('permission_denied on the list is scope_missing comment_management', async () => {
    const w = await seeded();
    w.fake.revokeScope(w.advertiserId, 'adCommentList');
    await expect(list(w)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'scope_missing',
      reauthorize: true,
      missingScopes: ['comment_management'],
    });
  });

  it('emoji-only and CJK content survives mapping', async () => {
    const w = await world();
    for (const [i, text] of ['🔥🔥🔥', '你好，世界'].entries()) {
      w.fake.addAdComment(w.advertiserId, {
        adId: '5',
        itemId: '6',
        text,
        createdAt: at(`2026-10-1${i}T08:00:00Z`),
      });
    }
    const page = await list({ ...w, top: { commentId: '' } });
    expect(page.items.map((c) => c.body)).toEqual(['你好，世界', '🔥🔥🔥']);
  });

  it('hasMore follows page_info', async () => {
    const w = await seeded();
    const p1 = await list(w, { pageSize: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = await list(w, { pageSize: 2, page: 2 });
    expect(p2.items).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
  });

  it('drops items with malformed ids individually and logs a count', async () => {
    const w = await seeded();
    w.tamper('/comment/list/', (d) => ({
      ...d,
      comments: [
        { ...(d.comments as Record<string, unknown>[])[0], comment_id: 'bad/id' },
        ...(d.comments as unknown[]).slice(1),
        { ...(d.comments as Record<string, unknown>[])[1], tiktok_item_id: 'x y' },
      ],
    }));
    const page = await list(w);
    expect(page.items).toHaveLength(2);
    expect(w.log).toHaveBeenCalledWith('tiktok items skipped', { code: 'invalid_item', count: 2 });
  });

  it('an oversized comments array is refused', async () => {
    const w = await seeded();
    w.tamper('/comment/list/', (d) => ({
      ...d,
      comments: Array.from({ length: 501 }, () => ({})),
    }));
    await expect(list(w)).rejects.toMatchObject({ code: 'invalid_tiktok_response' });
  });

  it('truncates content to 10000 code points without logging it', async () => {
    const w = await world();
    w.fake.addAdComment(w.advertiserId, {
      adId: '5',
      itemId: '6',
      text: '😀'.repeat(10_050),
      createdAt: at('2026-10-10T08:00:00Z'),
    });
    const page = await list({ ...w, top: { commentId: '' } });
    expect(Array.from(page.items[0]!.body)).toHaveLength(10_000);
    expect(JSON.stringify(w.log.mock.calls)).not.toContain('😀');
  });
});

describe('getComment', () => {
  it('finds a recent comment by id and returns null for an unknown one', async () => {
    const w = await seeded();
    const ref = { sourceExternalId: '111', externalId: w.top.commentId };
    await expect(w.connector.getComment(w.ctx, ref)).resolves.toMatchObject({ body: 'first' });
    await expect(
      w.connector.getComment(w.ctx, { ...ref, externalId: '12345' }),
    ).resolves.toBeNull();
  });
});
