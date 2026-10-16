import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { NormalizedComment } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { PgCommentStore, setCommentPlatformState } from './store.js';
import { applyPlatformComment } from './apply.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let t: Tenant;
let store: PgCommentStore;
let foreign: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'comments-store-test', onIdleError: () => {} });
  t = await seedTenant(ctx.c, 'cs');
  foreign = await seedTenant(ctx.c, 'cs-foreign');
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
let tick = Date.UTC(2026, 9, 14);
const normalized = (o: Partial<NormalizedComment>): NormalizedComment =>
  comment({ author: { externalId: 'u9', displayName: 'Ben', profileUrl: null }, ...o });
const opts = () => ({ ownAccountExternalId: '900', syncedAt: new Date(++tick) });
const countComments = async (s: ConnectionScope, ext: string) =>
  (
    await pool.query(
      `SELECT count(*)::int AS n FROM comment
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND external_id = $4`,
      [s.organizationId, s.brandId, s.connectionId, ext],
    )
  ).rows[0].n as number;
const sourceKind = async (s: ConnectionScope, ext: string) =>
  (
    await pool.query(
      `SELECT kind FROM source
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND external_id = $4`,
      [s.organizationId, s.brandId, s.connectionId, ext],
    )
  ).rows[0]?.kind as string | undefined;
const rowOf = async (id: string) =>
  (
    await pool.query(
      'SELECT * FROM comment WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
      [t.organizationId, t.brandId, id],
    )
  ).rows[0] as Record<string, unknown>;
/** Tenant B's organization and brand with tenant A's connection id. */
const foreignScope = (): ConnectionScope => ({
  organizationId: foreign.organizationId,
  brandId: foreign.brandId,
  connectionId: t.connectionId,
});

describe('PgCommentStore', () => {
  it('applies only snapshots newer than the stored one', async () => {
    const c = comment({ body: 'first' });
    const a = await store.upsertFromPlatform(scope(), c, own(1));
    expect(a).toMatchObject({ created: true, applied: true });
    const same = await store.upsertFromPlatform(scope(), c, own(2));
    expect(same).toMatchObject({ created: false, applied: true });
    const edited = await store.upsertFromPlatform(scope(), { ...c, body: 'second' }, own(3));
    expect(edited).toMatchObject({ applied: true, hookBody: 'second' });
    const stale = await store.upsertFromPlatform(scope(), { ...c, body: 'third' }, own(2));
    expect(stale).toMatchObject({ applied: false });
    expect((await store.load(t, a.commentId))?.body).toBe('second');
  });

  it('keeps a live body pending for the hook until it is marked delivered', async () => {
    const c = comment({ body: 'pending one' });
    const a = await store.upsertFromPlatform(scope(), c, own(1));
    expect(a).toMatchObject({ hookBody: 'pending one' });
    const again = await store.upsertFromPlatform(scope(), c, own(2));
    expect(again).toMatchObject({ hookBody: 'pending one' });
    // Delivering an older version leaves a newer pending body alone.
    await store.upsertFromPlatform(scope(), { ...c, body: 'pending two' }, own(3));
    await store.markHookDelivered(scope(), a.commentId, 'pending one');
    const still = await store.upsertFromPlatform(scope(), { ...c, body: 'pending two' }, own(4));
    expect(still).toMatchObject({ hookBody: 'pending two' });
    await store.markHookDelivered(scope(), a.commentId, 'pending two');
    const done = await store.upsertFromPlatform(scope(), { ...c, body: 'pending two' }, own(5));
    expect(done).toMatchObject({ hookBody: null });
  });

  it('a backfill snapshot with a new body is never evaluated: it replaces and clears the pending marker', async () => {
    const c = comment({ body: 'live text' });
    const a = await store.upsertFromPlatform(scope(), c, own(1));
    expect(a.hookBody).toBe('live text');
    const r = await store.upsertFromPlatform(
      scope(),
      { ...c, body: 'backfilled text' },
      {
        ...own(2),
        origin: 'backfill',
      },
    );
    expect(r).toMatchObject({ applied: true, hookBody: null });
    expect(await store.pendingHooks(scope(), 100)).not.toContainEqual(
      expect.objectContaining({ commentId: a.commentId }),
    );
  });

  it('pendingHooks lists only this connection, live, non-deleted rows', async () => {
    const c = comment({ body: 'listed' });
    const a = await store.upsertFromPlatform(scope(), c, own(1));
    expect(await store.pendingHooks(scope(), 1000)).toContainEqual({
      commentId: a.commentId,
      body: 'listed',
      attempted: false,
    });
    expect(await store.pendingHooks(foreignScope(), 1000)).toEqual([]);
  });

  it('a new snapshot that arrives already deleted gets no pending marker', async () => {
    const c = comment({ body: 'gone on arrival', platformState: 'deleted' });
    const r = await store.upsertFromPlatform(scope(), c, own(1));
    expect(r).toMatchObject({ created: true, hookBody: null });
    const { rows } = await pool.query<{ hook_pending_sha256: Buffer | null }>(
      'SELECT hook_pending_sha256 FROM comment WHERE id = $1',
      [r.commentId],
    );
    expect(rows[0]?.hook_pending_sha256).toBeNull();
  });

  it('a late visible snapshot does not take a marker from a deleted row', async () => {
    const c = comment({ body: 'late' });
    await store.recordDeleted(
      scope(),
      { sourceExternalId: c.sourceExternalId, externalId: c.externalId },
      { syncedAt: at(1), occurredAt: at(1) },
    );
    const r = await store.upsertFromPlatform(scope(), c, own(2));
    expect(r).toMatchObject({ hookBody: null });
    expect(await store.pendingHooks(scope(), 1000)).not.toContainEqual(
      expect.objectContaining({ commentId: r.commentId }),
    );
  });

  it('a delete clears the pending marker', async () => {
    const c = comment({ body: 'to delete' });
    const a = await store.upsertFromPlatform(scope(), c, own(1));
    await store.markDeleted(
      scope(),
      { sourceExternalId: c.sourceExternalId, externalId: c.externalId },
      at(2),
    );
    const r = await pool.query('SELECT hook_pending_sha256 FROM comment WHERE id = $1', [
      a.commentId,
    ]);
    expect(r.rows[0].hook_pending_sha256).toBeNull();
  });

  it('never marks backfilled comments pending', async () => {
    const r = await store.upsertFromPlatform(scope(), comment({ body: 'old' }), {
      ...own(1),
      origin: 'backfill',
    });
    expect(r).toMatchObject({ hookBody: null });
  });

  it('creates once and is idempotent for the same snapshot', async () => {
    const c = comment();
    const a = await store.upsertFromPlatform(scope(), c, own(1));
    const b = await store.upsertFromPlatform(scope(), c, own(1));
    expect(a).toMatchObject({ created: true, applied: true });
    expect(b).toEqual({
      commentId: a.commentId,
      created: false,
      applied: false,
      hookBody: 'hello',
    });
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
      parentPlatformState: null,
      postedAt: c.postedAt,
      permalink: 'https://www.facebook.com/x',
      isOwnAccount: false,
      connectionStatus: 'active',
      privateReplied: false,
      origin: 'organic',
      ads: [],
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
    expect(newer).toEqual({
      commentId: stale.commentId,
      created: false,
      applied: true,
      hookBody: 'v3',
    });
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

  it('leaves deleted comments out before the limit when asked', async () => {
    const x = await seedTenant(ctx.c, 'cs-del');
    const sx = scopeOf(x);
    const kept = await store.upsertFromPlatform(
      sx,
      comment({ postedAt: new Date(Date.UTC(2026, 9, 3, 0, 0, 0)) }),
      own(1),
    );
    const gone = comment({ postedAt: new Date(Date.UTC(2026, 9, 3, 0, 0, 1)) });
    const { commentId: goneId } = await store.upsertFromPlatform(sx, gone, own(1));
    await store.recordDeleted(
      sx,
      { sourceExternalId: gone.sourceExternalId, externalId: gone.externalId },
      { syncedAt: at(2), occurredAt: at(2) },
    );
    expect((await store.list(x, { before: null, limit: 1 })).map((r) => r.id)).toEqual([goneId]);
    expect(
      (await store.list(x, { before: null, limit: 1, excludeDeleted: true })).map((r) => r.id),
    ).toEqual([kept.commentId]);
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

describe('per-connection comment identity', () => {
  it('the same comment through two sources is one row', async () => {
    const c = normalized({ sourceExternalId: '900_1', externalId: '900_1_77' });
    const a = await store.upsertFromPlatform(scope(), c, opts());
    const b = await store.upsertFromPlatform(scope(), { ...c, sourceExternalId: '900_2' }, opts());
    expect(b.commentId).toBe(a.commentId);
    expect(b.created).toBe(false);
    expect(await countComments(scope(), '900_1_77')).toBe(1);
  });
  it('a reply stored under another source still links to its parent', async () => {
    const parent = await store.upsertFromPlatform(
      scope(),
      normalized({ sourceExternalId: 'm1', externalId: 'x-p1' }),
      opts(),
    );
    const child = await store.upsertFromPlatform(
      scope(),
      normalized({ sourceExternalId: 'm2', externalId: 'x-c1', parentExternalId: 'x-p1' }),
      opts(),
    );
    expect((await store.load(t, child.commentId))!.parentCommentId).toBe(parent.commentId);
  });
  it('ensureAdSource promotes an organic source and a later webhook never demotes it', async () => {
    await store.upsertFromPlatform(
      scope(),
      normalized({ sourceExternalId: '900_5', externalId: '900_5_1' }),
      opts(),
    );
    expect(await sourceKind(scope(), '900_5')).toBe('organic_post');
    await store.ensureAdSource(scope(), '900_5');
    await store.upsertFromPlatform(
      scope(),
      normalized({ sourceExternalId: '900_5', externalId: '900_5_2' }),
      opts(),
    );
    expect(await sourceKind(scope(), '900_5')).toBe('ad_post');
  });
  it("ensureAdSource cannot touch another tenant's source", async () => {
    await expect(store.ensureAdSource(foreignScope(), '900_5')).rejects.toThrow();
    expect(
      await sourceKind({ ...foreignScope(), connectionId: foreign.connectionId }, '900_5'),
    ).toBe(undefined);
  });
  it('applyPlatformComment with adSourceId labels a comment filed under another source', async () => {
    const r = await applyPlatformComment(
      store,
      scope(),
      normalized({ sourceExternalId: 'orig', externalId: 'k1' }),
      opts(),
    );
    expect(r.outcome).toBe('created');
    const adSrc = await store.ensureAdSource(scope(), 'admedia');
    const again = await applyPlatformComment(
      store,
      scope(),
      normalized({ sourceExternalId: 'admedia', externalId: 'k1' }),
      { ...opts(), adSourceId: adSrc },
    );
    expect(again).toMatchObject({ commentId: r.commentId, outcome: 'updated' });
    expect((await rowOf(r.commentId)).ad_source_id).toBe(adSrc);
  });
  it('a stale read through an ad source still records the ad path', async () => {
    const first = opts();
    const later = opts();
    const r = await applyPlatformComment(
      store,
      scope(),
      normalized({ sourceExternalId: 'orig2', externalId: 'k2' }),
      later,
    );
    const adSrc = await store.ensureAdSource(scope(), 'admedia2');
    const stale = await applyPlatformComment(
      store,
      scope(),
      normalized({ sourceExternalId: 'admedia2', externalId: 'k2' }),
      { ...first, adSourceId: adSrc },
    );
    expect(stale.outcome).toBe('stale');
    expect((await rowOf(r.commentId)).ad_source_id).toBe(adSrc);
  });
  it('records ingest origin on insert only', async () => {
    const c = normalized({ externalId: 'origin-1' });
    await applyPlatformComment(store, scope(), c, { ...opts(), origin: 'backfill' });
    await applyPlatformComment(store, scope(), { ...c, body: 'edited' }, opts());
    const r = await pool.query(
      `SELECT ingest_origin, body FROM comment WHERE connection_id = $1 AND external_id = 'origin-1'`,
      [t.connectionId],
    );
    expect(r.rows[0]).toEqual({ ingest_origin: 'backfill', body: 'edited' });
  });
  it('ingest origin defaults to live', async () => {
    await applyPlatformComment(store, scope(), normalized({ externalId: 'origin-2' }), opts());
    const r = await pool.query(
      `SELECT ingest_origin FROM comment WHERE connection_id = $1 AND external_id = 'origin-2'`,
      [t.connectionId],
    );
    expect(r.rows[0].ingest_origin).toBe('live');
  });
  it('latestActionActor is the actor of the newest pending or applied action', async () => {
    const { commentId } = await store.upsertFromPlatform(scope(), comment(), own(1));
    expect(await store.latestActionActor(t, commentId)).toBeNull();
    const act = (actor: string, status: string, createdAt: string) =>
      pool.query(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
           request_key, status, completed_at, created_at)
         VALUES ($1, $2, $3, $4, 'hide', $5, $6, $7::text,
           CASE WHEN $7::text = 'pending' THEN NULL ELSE now() END, $8::timestamptz)`,
        [t.organizationId, t.brandId, t.connectionId, commentId, actor, `k:${++n}`, status, createdAt],
      );
    await act('user', 'applied', '2026-10-01T00:00:00Z');
    await act('policy', 'applied', '2026-10-02T00:00:00Z');
    await act('rule', 'failed', '2026-10-03T00:00:00Z');
    expect(await store.latestActionActor(t, commentId)).toBe('policy');
    expect(await store.latestActionActor(foreign, commentId)).toBeNull();
  });
});
