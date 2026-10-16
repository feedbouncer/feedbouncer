import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { PgReviewQueue } from './review.js';
import { scopeOf, seedCommentRow, seedModerationActionRow } from './testing.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let queue: PgReviewQueue;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'actions-review-test', onIdleError: () => {} });
  queue = new PgReviewQueue(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const fresh = async () => {
  const t = await seedTenant(ctx.c, `rv${++n}`);
  const comment = await seedCommentRow(ctx.c, t, 'needs a look');
  return { t, comment, scope: scopeOf(t) };
};
const open = (f: Awaited<ReturnType<typeof fresh>>, commentId = f.comment.id) =>
  withTransaction(pool, (tx) =>
    queue.open(tx, f.scope, { commentId, source: 'action_step', ruleId: f.t.ruleId }),
  );

describe('PgReviewQueue', () => {
  it('open is idempotent while open; resolve only once', async () => {
    const f = await fresh();
    const a = await open(f);
    expect(a.created).toBe(true);
    const b = await open(f);
    expect(b).toEqual({ id: a.id, created: false });

    const resolve = (resolution: 'approved' | 'hidden', actionId: string | null = null) =>
      withTransaction(pool, (tx) =>
        queue.resolve(tx, f.scope, a.id, { resolution, userId: f.t.userId, actionId }),
      );
    const actionId = await seedModerationActionRow(ctx.c, f.comment, { kind: 'hide' });
    expect(await resolve('hidden', actionId)).toBe(true);
    expect(await resolve('approved')).toBe(false);
    const item = await queue.load(f.scope, a.id);
    expect(item).toMatchObject({ status: 'resolved', resolution: 'hidden' });
    expect(item!.resolvedAt).toBeInstanceOf(Date);

    const c = await open(f);
    expect(c.created).toBe(true);
    expect(c.id).not.toBe(a.id);
  });

  it('returns the view with comment, author, rule and platform', async () => {
    const f = await fresh();
    const withAuthor = await seedCommentRow(ctx.c, f.t, 'spam here', { authorId: f.t.authorId });
    const { id } = await open(f, withAuthor.id);
    const item = await queue.load(f.scope, id);
    expect(item).toMatchObject({
      id,
      commentId: withAuthor.id,
      connectionId: f.t.connectionId,
      source: 'action_step',
      ruleId: f.t.ruleId,
      ruleName: 'Scam links',
      status: 'open',
      resolution: null,
      resolvedAt: null,
      commentBody: 'spam here',
      authorName: `Author rv${n}`,
      platform: 'facebook',
    });
  });

  it('lists by status, newest first, with a before cursor', async () => {
    const f = await fresh();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await seedCommentRow(ctx.c, f.t, `c${i}`);
      ids.push((await open(f, c.id)).id);
    }
    await withTransaction(pool, (tx) =>
      queue.resolve(tx, f.scope, ids[0]!, {
        resolution: 'dismissed',
        userId: null,
        actionId: null,
      }),
    );
    const openItems = await queue.list(f.scope, { status: 'open', limit: 10 });
    expect(openItems.map((i) => i.id).sort()).toEqual([ids[1]!, ids[2]!].sort());
    const resolved = await queue.list(f.scope, { status: 'resolved', limit: 10 });
    expect(resolved.map((i) => i.id)).toEqual([ids[0]]);

    const page1 = await queue.list(f.scope, { status: 'open', limit: 1 });
    const page2 = await queue.list(f.scope, { status: 'open', limit: 1, before: page1[0]!.id });
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page2[0]!.id).not.toBe(page1[0]!.id);
    expect(await queue.list(f.scope, { status: 'open', limit: 5, before: page2[0]!.id })).toEqual(
      [],
    );
  });

  it('every method called with brand B scope returns null/empty/false for brand A ids', async () => {
    const a = await fresh();
    const b = await fresh();
    const { id } = await open(a);
    expect(await queue.load(b.scope, id)).toBeNull();
    expect(await queue.list(b.scope, { status: 'open', limit: 10 })).toEqual([]);
    expect(
      await withTransaction(pool, (tx) =>
        queue.resolve(tx, b.scope, id, {
          resolution: 'approved',
          userId: b.t.userId,
          actionId: null,
        }),
      ),
    ).toBe(false);
    expect((await queue.load(a.scope, id))!.status).toBe('open');
    // Opening A's comment through B's scope must not attach to A's item.
    await expect(open(b, a.comment.id)).rejects.toThrow();
  });
});
