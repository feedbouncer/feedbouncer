import { describe, expect, it } from 'vitest';
import { world } from './test-world.js';

describe('listSources', () => {
  it('pages videos with numeric cursor', async () => {
    const { fake, connector, ctx, businessId } = await world();
    for (let i = 0; i < 44; i++) fake.addVideo(businessId, { createdAtSec: 1_700_000_000 + i });
    const p1 = await connector.listSources!(ctx, { cursor: null });
    expect(p1.items).toHaveLength(20);
    expect(p1.nextCursor).toBe('20');
    const p2 = await connector.listSources!(ctx, { cursor: p1.nextCursor });
    const p3 = await connector.listSources!(ctx, { cursor: p2.nextCursor });
    expect(p3.items).toHaveLength(5);
    expect(p3.nextCursor).toBeNull();
    expect(p1.items[0]).toMatchObject({ kind: 'video', active: true });
    expect(p1.items[0]!.permalink).toMatch(/^https:\/\/www\.tiktok\.com\/@shop\/video\/\d+$/);
  });

  it('off-host share_url becomes null permalink', async () => {
    const { fake, connector, ctx, businessId } = await world();
    fake.addVideo(businessId, { shareUrl: 'https://evil.example/x', createdAtSec: 2_000_000_000 });
    const page = await connector.listSources!(ctx, { cursor: null });
    expect(page.items[0]!.permalink).toBeNull();
  });

  it('rejects a non-numeric cursor without calling TikTok', async () => {
    const { fake, connector, ctx } = await world();
    await expect(connector.listSources!(ctx, { cursor: '1/../2' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(connector.listSources!(ctx, { cursor: '9007199254740993' })).rejects.toMatchObject(
      { code: 'invalid_cursor' },
    );
    expect(fake.calls('businessVideoList')).toHaveLength(0);
  });

  it('drops a video with a malformed item_id and keeps the rest', async () => {
    const { connector, ctx, tamper, log } = await world();
    tamper('business/video/list', (d) => ({
      ...d,
      videos: [...(d.videos as object[]), { item_id: 'a/b', share_url: null }],
    }));
    const page = await connector.listSources!(ctx, { cursor: null });
    expect(page.items).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('tiktok items skipped', { code: 'invalid_item', count: 1 });
  });

  it('permission_denied on the video list is scope_missing with video.list', async () => {
    const { fake, connector, ctx, businessId } = await world();
    fake.revokeScope(businessId, 'businessVideoList');
    await expect(connector.listSources!(ctx, { cursor: null })).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'scope_missing',
      reauthorize: true,
      missingScopes: ['video.list'],
    });
  });
});
