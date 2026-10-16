import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { REVIEW_GRACE_MS, type Clock } from '@feedbouncer/connectors';
import { createLogger } from '@feedbouncer/service-runtime';
import { ReviewModeSweeper } from './sweeper.js';
import { PgSuggestionStore } from './suggestions.js';
import { scopeOf, seedCommentRow } from './testing.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let sweeper: ReviewModeSweeper;
let store: PgSuggestionStore;
let n = 0;
const clock: Clock = { now: () => Date.now() };

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'actions-sweeper-test', onIdleError: () => {} });
  store = new PgSuggestionStore(pool);
  sweeper = new ReviewModeSweeper({
    pool,
    clock,
    log: createLogger('actions-sweeper-test', 'error', () => {}),
  });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const fresh = async () => {
  const t = await seedTenant(ctx.c, `sw${++n}`, { reviewMode: 'on' });
  await ctx.c.query("UPDATE rule SET mode = 'enforce' WHERE id = $1", [t.ruleId]);
  const comment = await seedCommentRow(ctx.c, t, 'buy now', { authorId: t.authorId });
  const r = await store.propose(scopeOf(t), {
    commentId: comment.id,
    source: { type: 'classifier', ref: randomUUID() },
    steps: [{ type: 'hide' }],
    reason: 'matched',
  });
  if (!('suggestionId' in r)) throw new Error(r.skipped);
  return { t, comment, sid: r.suggestionId };
};
const row = async (sid: string) =>
  (
    await pool.query<{
      status: string;
      status_reason: string | null;
      decided_by_user_id: string | null;
    }>('SELECT status, status_reason, decided_by_user_id FROM action_suggestion WHERE id = $1', [
      sid,
    ])
  ).rows[0]!;

describe('ReviewModeSweeper', () => {
  it('tick persists expired after grace and never executes', async () => {
    const f = await fresh();
    const hours = 168 + REVIEW_GRACE_MS / 3_600_000 + 1;
    await ctx.c.query(
      `UPDATE connection SET review_mode_started_at = now() - $2 * interval '1 hour',
              review_mode_ends_at = now() - $2 * interval '1 hour' + interval '168 hours' WHERE id = $1`,
      [f.t.connectionId, hours],
    );
    expect(await sweeper.tick()).toEqual({ expired: 1, notApplicable: 0 });
    expect(await row(f.sid)).toEqual({
      status: 'expired',
      status_reason: 'grace_period_ended',
      decided_by_user_id: null,
    });
    const runs = await pool.query('SELECT 1 FROM action_run WHERE brand_id = $1', [f.t.brandId]);
    expect(runs.rowCount).toBe(0);
  });

  it('tick persists comment_gone', async () => {
    const f = await fresh();
    await ctx.c.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [
      f.comment.id,
    ]);
    expect(await sweeper.tick()).toEqual({ expired: 0, notApplicable: 1 });
    expect(await row(f.sid)).toMatchObject({
      status: 'not_applicable',
      status_reason: 'comment_gone',
    });
  });

  it('tick is idempotent', async () => {
    const f = await fresh();
    await ctx.c.query("UPDATE comment SET body = 'edited' WHERE id = $1", [f.comment.id]);
    expect(await sweeper.tick()).toEqual({ expired: 0, notApplicable: 1 });
    expect(await sweeper.tick()).toEqual({ expired: 0, notApplicable: 0 });
    expect(await row(f.sid)).toMatchObject({
      status: 'not_applicable',
      status_reason: 'comment_edited',
    });
  });
});
