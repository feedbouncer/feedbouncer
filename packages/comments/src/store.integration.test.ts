import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { NormalizedComment } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { PgCommentStore, setCommentPlatformState } from './store.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let t: Tenant;
let store: PgCommentStore;
beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'comments-store-test', onIdleError: () => {} });
  t = await seedTenant(ctx.c, 'cs');
  store = new PgCommentStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
const scopeOf = (x: Tenant): ConnectionScope => ({
  organizationId: x.organizationId,
  brandId: x.brandId,
  connectionId: x.connectionId,
});
const scope = () => scopeOf(t);
let n = 0;
const comment = (over: Partial<NormalizedComment> = {}): NormalizedComment => ({
  externalId: `c${++n}`,
  sourceExternalId: 'post-1',
  parentExternalId: null,
  author: { externalId: 'u1', displayName: 'Ann', profileUrl: null },
  body: 'hello',
  postedAt: new Date('2026-10-13T09:00:00Z'),
  platformState: 'visible',
  permalink: 'https://www.facebook.com/x',
  ...over,
});
const at = (s: number) => new Date(Date.UTC(2026, 9, 13, 10, 0, s));
const own = (s: number) => ({ ownAccountExternalId: 'page', syncedAt: at(s) });

describe('PgCommentStore', () => {
  it('creates once and is idempotent for the same snapshot', async () => {
    const c = comment();
    const a = await store.upsertFromPlatform(scope(), c, own(1));
    const b = await store.upsertFromPlatform(scope(), c, own(1));
    expect(a).toMatchObject({ created: true, applied: true });
    expect(b).toEqual({ commentId: a.commentId, created: false, applied: false });
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM comment WHERE external_id = $1', [
          c.externalId,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it('stores the full row: author, permalink, state, source', async () => {
    const c = comment({ platformState: 'hidden' });
    const { commentId } = await store.upsertFromPlatform(scope(), c, own(1));
    expect(await store.load(t, commentId)).toEqual({
      id: commentId,
      connectionId: t.connectionId,
      platform: 'facebook',
      sourceExternalId: 'post-1',
      externalId: c.externalId,
      parentExternalId: null,
      parentCommentId: null,
      authorExternalId: 'u1',
      authorName: 'Ann',
      body: 'hello',
      platformState: 'hidden',
      postedAt: c.postedAt,
      permalink: 'https://www.facebook.com/x',
      isOwnAccount: false,
      connectionStatus: 'active',
    });
  });

  it('a newer snapshot wins, an older one never overwrites (out of order)', async () => {
    const c = comment();
    await store.upsertFromPlatform(scope(), { ...c, body: 'v2' }, own(5));
    const stale = await store.upsertFromPlatform(scope(), { ...c, body: 'v1' }, own(3));
    expect(stale.applied).toBe(false);
    expect((await store.load(t, stale.commentId))?.body).toBe('v2');
    const newer = await store.upsertFromPlatform(
      scope(),
      { ...c, body: 'v3', platformState: 'hidden' },
      own(7),
    );
    expect(newer).toEqual({ commentId: stale.commentId, created: false, applied: true });
    expect(await store.load(t, stale.commentId)).toMatchObject({
      body: 'v3',
      platformState: 'hidden',
    });
  });

  it('deleted is sticky even against a newer fetch', async () => {
    const c = comment();
    const { commentId } = await store.upsertFromPlatform(scope(), c, own(1));
    expect(
      await store.markDeleted(
        scope(),
        { sourceExternalId: c.sourceExternalId, externalId: c.externalId },
        at(2),
      ),
    ).toBe(commentId);
    await store.upsertFromPlatform(
      scope(),
      { ...c, platformState: 'visible', body: 'resurrected?' },
      own(9),
    );
    expect((await store.load(t, commentId))?.platformState).toBe('deleted');
  });

  it('a delete that lands after a newer fetch still deletes, and keeps the newer sync time', async () => {
    const c = comment();
    const { commentId } = await store.upsertFromPlatform(scope(), c, own(9));
    await store.markDeleted(
      scope(),
      { sourceExternalId: 'post-1', externalId: c.externalId },
      at(2),
    );
    expect((await store.load(t, commentId))?.platformState).toBe('deleted');
    const r = await pool.query('SELECT platform_synced_at FROM comment WHERE id = $1', [commentId]);
    expect(r.rows[0].platform_synced_at).toEqual(at(9));
    // an older fetch is still refused after the delete
    expect((await store.upsertFromPlatform(scope(), c, own(5))).applied).toBe(false);
  });

  it('markDeleted of an unknown comment stores nothing and returns null', async () => {
    const ref = { sourceExternalId: 'post-1', externalId: 'never-seen' };
    expect(await store.markDeleted(scope(), ref, at(1))).toBeNull();
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM comment WHERE external_id = $1', [
          ref.externalId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('recordDeleted leaves a tombstone so a later stale fetch cannot resurrect the comment', async () => {
    const c = comment();
    const ref = { sourceExternalId: c.sourceExternalId, externalId: c.externalId };
    const id = await store.recordDeleted(scope(), ref, { syncedAt: at(2), occurredAt: at(1) });
    expect(await store.load(t, id)).toMatchObject({ platformState: 'deleted', body: '' });
    expect(await store.recordDeleted(scope(), ref, { syncedAt: at(3), occurredAt: at(1) })).toBe(
      id,
    );
    const late = await store.upsertFromPlatform(scope(), { ...c, body: 'late' }, own(4));
    expect(late).toMatchObject({ commentId: id, created: false });
    expect(await store.load(t, id)).toMatchObject({
      platformState: 'deleted',
      postedAt: c.postedAt,
      authorExternalId: 'u1',
    });
  });

  it('setCommentPlatformState follows our own actions but never revives a deleted comment', async () => {
    const c = comment();
    const { commentId } = await store.upsertFromPlatform(scope(), c, own(1));
    await setCommentPlatformState(pool, scope(), commentId, 'hidden');
    expect((await store.load(t, commentId))?.platformState).toBe('hidden');
    await setCommentPlatformState(pool, scope(), commentId, 'deleted');
    await setCommentPlatformState(pool, scope(), commentId, 'visible');
    expect((await store.load(t, commentId))?.platformState).toBe('deleted');
  });

  it('links a reply that arrives before its parent', async () => {
    const parent = comment();
    const child = comment({ parentExternalId: parent.externalId });
    const { commentId: childId } = await store.upsertFromPlatform(scope(), child, own(1));
    expect((await store.load(t, childId))?.parentCommentId).toBeNull();
    const { commentId: parentId } = await store.upsertFromPlatform(scope(), parent, own(2));
    expect((await store.load(t, childId))?.parentCommentId).toBe(parentId);
  });

  it('links a reply that arrives after its parent', async () => {
    const parent = comment();
    const { commentId: parentId } = await store.upsertFromPlatform(scope(), parent, own(1));
    const { commentId: childId } = await store.upsertFromPlatform(
      scope(),
      comment({ parentExternalId: parent.externalId }),
      own(2),
    );
    expect(await store.load(t, childId)).toMatchObject({
      parentCommentId: parentId,
      parentExternalId: parent.externalId,
    });
  });

  it('flags comments authored by the page itself', async () => {
    const { commentId } = await store.upsertFromPlatform(
      scope(),
      comment({ author: { externalId: 'page', displayName: 'Shop', profileUrl: null } }),
      own(1),
    );
    expect((await store.load(t, commentId))?.isOwnAccount).toBe(true);
  });

  it('stores empty bodies (stickers) and missing authors', async () => {
    const { commentId } = await store.upsertFromPlatform(
      scope(),
      comment({ body: '', author: null }),
      own(1),
    );
    expect(await store.load(t, commentId)).toMatchObject({ body: '', authorExternalId: null });
  });

  it('stores text as plain text with NUL replaced', async () => {
    const { commentId } = await store.upsertFromPlatform(
      scope(),
      comment({
        body: 'a\u0000<b>x</b>',
        author: { externalId: 'u-nul', displayName: 'N\u0000n', profileUrl: null },
      }),
      own(1),
    );
    expect(await store.load(t, commentId)).toMatchObject({
      body: 'a�<b>x</b>',
      authorName: 'N�n',
    });
  });

  it('lists newest first with a before cursor, a limit and a connection filter', async () => {
    const x = await seedTenant(ctx.c, 'cs-list');
    const sx = scopeOf(x);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = comment({ postedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) });
      ids.push((await store.upsertFromPlatform(sx, c, own(1))).commentId);
    }
    expect((await store.list(x, { before: null, limit: 50 })).map((r) => r.id)).toEqual(
      [...ids].reverse(),
    );
    expect((await store.list(x, { before: null, limit: 1 })).map((r) => r.id)).toEqual([ids[2]]);
    expect(
      (
        await store.list(x, {
          before: { postedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 2)), id: ids[2]! },
          limit: 50,
        })
      ).map((r) => r.id),
    ).toEqual([ids[1], ids[0]]);
    expect(await store.list(x, { before: null, limit: 50, connectionId: t.connectionId })).toEqual(
      [],
    );
    expect(
      (await store.list(x, { before: null, limit: 50, connectionId: x.connectionId })).length,
    ).toBe(3);
  });

  it('pages through comments that share one posted_at second without skipping any', async () => {
    const x = await seedTenant(ctx.c, 'cs-tie');
    const sx = scopeOf(x);
    const same = new Date(Date.UTC(2026, 9, 2, 0, 0, 0));
    const expected: string[] = [];
    for (let i = 0; i < 3; i++)
      expected.push(
        (await store.upsertFromPlatform(sx, comment({ postedAt: same }), own(1))).commentId,
      );
    expected.sort().reverse();
    const page1 = await store.list(x, { before: null, limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(expected.slice(0, 2));
    const last = page1[1]!;
    const page2 = await store.list(x, {
      before: { postedAt: last.postedAt, id: last.id },
      limit: 2,
    });
    expect(page2.map((r) => r.id)).toEqual([expected[2]]);
  });

  it('load/list never cross brands', async () => {
    const other = await seedTenant(ctx.c, 'cs2');
    const { commentId } = await store.upsertFromPlatform(scope(), comment(), own(1));
    expect(await store.load(other, commentId)).toBeNull();
    expect((await store.list(other, { before: null, limit: 50 })).map((r) => r.id)).not.toContain(
      commentId,
    );
    expect(await store.load(t, 'not-a-uuid')).toBeNull();
  });

  it('writes never cross tenants', async () => {
    const other = await seedTenant(ctx.c, 'cs3');
    const c = comment();
    const { commentId } = await store.upsertFromPlatform(scope(), c, own(1));
    const ref = { sourceExternalId: c.sourceExternalId, externalId: c.externalId };
    // Another tenant's scope sees its own (empty) world.
    expect(await store.markDeleted(scopeOf(other), ref, at(2))).toBeNull();
    await setCommentPlatformState(pool, scopeOf(other), commentId, 'hidden');
    expect((await store.load(t, commentId))?.platformState).toBe('visible');
    // A forged scope (our connection, their organization) is refused.
    const forged = { ...scope(), organizationId: other.organizationId, brandId: other.brandId };
    await expect(store.upsertFromPlatform(forged, comment(), own(3))).rejects.toThrow();
    expect(await store.markDeleted(forged, ref, at(3))).toBeNull();
    expect((await store.load(t, commentId))?.platformState).toBe('visible');
    // Same platform ids in another tenant are a different comment.
    const theirs = await store.upsertFromPlatform(scopeOf(other), c, own(1));
    expect(theirs.created).toBe(true);
    expect(theirs.commentId).not.toBe(commentId);
  });
});
