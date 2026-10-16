import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { PgReviewQueue } from './review.js';
import { PgActionRunStore } from './runs.js';
import type { ActionStep } from './steps.js';
import {
  scopeOf,
  seedCommentRow,
  seedEvaluationRow,
  seedModerationActionRow,
  seedSuggestionRow,
  type Seeded,
} from './testing.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgActionRunStore;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'actions-runs-test', onIdleError: () => {} });
  store = new PgActionRunStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const HIDE: ActionStep = { type: 'hide' };
const FLAG: ActionStep = { type: 'flag_for_review' };
const REPLY: ActionStep = { type: 'auto_reply', template: 'Thanks' };
const BAN: ActionStep = { type: 'ban', confirmHardToReverse: true };

const fresh = async () => {
  const t = await seedTenant(ctx.c, `ar${++n}`);
  const comment = await seedCommentRow(ctx.c, t, 'hello');
  return { t, comment, scope: scopeOf(t) };
};
const mkRun = async (
  f: Awaited<ReturnType<typeof fresh>>,
  steps: readonly ActionStep[] = [HIDE],
  over: { dryRun?: boolean; comment?: Seeded } = {},
) => {
  const c = over.comment ?? f.comment;
  return store.createRun(f.scope, {
    commentId: c.id,
    ruleId: f.t.ruleId,
    evaluationId: await seedEvaluationRow(ctx.c, c),
    dryRun: over.dryRun ?? false,
    steps,
  });
};
const settle = (
  f: Awaited<ReturnType<typeof fresh>>,
  stepId: string,
  status: 'succeeded' | 'failed' = 'succeeded',
) =>
  withTransaction(pool, async (tx) => {
    const flag = (await store.loadStep(f.scope, stepId))?.type === 'flag_for_review';
    const item = flag
      ? await new PgReviewQueue(pool).open(tx, f.scope, {
          commentId: f.comment.id,
          source: 'action_step',
          ruleId: f.t.ruleId,
        })
      : null;
    await store.settleStep(tx, f.scope, stepId, {
      status,
      reason: status === 'failed' ? 'x_failed' : null,
      ...(item && { reviewItemId: item.id }),
    });
  });
const undo = (f: Awaited<ReturnType<typeof fresh>>, stepId: string) =>
  withTransaction(pool, (tx) => store.markUndone(tx, f.scope, stepId, f.t.userId, null));

describe('createRun', () => {
  it('is idempotent per (evaluation, rule) and stores steps in STEP_ORDER positions', async () => {
    const f = await fresh();
    const evaluationId = await seedEvaluationRow(ctx.c, f.comment);
    const input = {
      commentId: f.comment.id,
      ruleId: f.t.ruleId,
      evaluationId,
      dryRun: false,
      steps: [FLAG, REPLY, HIDE],
    };
    const a = await store.createRun(f.scope, input);
    expect(a.steps.map((s) => [s.position, s.type, s.status])).toEqual([
      [0, 'flag_for_review', 'pending'],
      [1, 'auto_reply', 'pending'],
      [2, 'hide', 'pending'],
    ]);
    expect(a.steps[1]!.config).toEqual(REPLY);
    expect(a).toMatchObject({ connectionId: f.t.connectionId, dryRun: false, completedAt: null });
    const b = await store.createRun(f.scope, { ...input, steps: [BAN] });
    expect(b.id).toBe(a.id);
    expect(b.steps.map((s) => s.type)).toEqual(['flag_for_review', 'auto_reply', 'hide']);
    const count = await ctx.c.query('SELECT 1 FROM action_run_step WHERE run_id = $1', [a.id]);
    expect(count.rowCount).toBe(3);
  });

  it('sorts unordered input into STEP_ORDER', async () => {
    const f = await fresh();
    const run = await mkRun(f, [BAN, HIDE, FLAG]);
    expect(run.steps.map((s) => s.type)).toEqual(['flag_for_review', 'hide', 'ban']);
  });
});

describe('createSuggestionRun', () => {
  it('is idempotent per suggestion and stores steps in STEP_ORDER', async () => {
    const f = await fresh();
    const suggestionId = await seedSuggestionRow(ctx.c, f.comment);
    const input = {
      suggestionId,
      commentId: f.comment.id,
      userId: f.t.userId,
      steps: [{ type: 'ban', confirmHardToReverse: true }, { type: 'hide' }] as const,
    };
    const a = await withTransaction(pool, (tx) => store.createSuggestionRun(tx, f.scope, input));
    expect(a.steps.map((s) => [s.position, s.type, s.status])).toEqual([
      [0, 'hide', 'pending'],
      [1, 'ban', 'pending'],
    ]);
    expect(a).toMatchObject({
      suggestionId,
      approvedByUserId: f.t.userId,
      ruleId: null,
      evaluationId: null,
      dryRun: false,
    });
    const b = await withTransaction(pool, (tx) =>
      store.createSuggestionRun(tx, f.scope, { ...input, steps: [{ type: 'hide' }] }),
    );
    expect(b.id).toBe(a.id);
    expect(b.steps).toHaveLength(2);
  });
});

describe('hasActiveBan', () => {
  it('is true for a pending or applied ban of the author until a later applied unban', async () => {
    const f = await fresh();
    const other = await seedCommentRow(ctx.c, f.t, 'again', { authorId: f.t.authorId });
    const mine = await seedCommentRow(ctx.c, f.t, 'mine', { authorId: f.t.authorId });
    expect(await store.hasActiveBan(f.scope, mine.id)).toBe(false);
    await seedModerationActionRow(ctx.c, other, { kind: 'ban_author', status: 'pending' });
    expect(await store.hasActiveBan(f.scope, mine.id)).toBe(true);
    await seedModerationActionRow(ctx.c, other, { kind: 'unban_author', status: 'applied' });
    expect(await store.hasActiveBan(f.scope, mine.id)).toBe(false);
    await seedModerationActionRow(ctx.c, mine, { kind: 'ban_author', status: 'applied' });
    expect(await store.hasActiveBan(f.scope, mine.id)).toBe(true);
  });
});

describe('withRunLocked', () => {
  it('passes the run and returns null outside the scope', async () => {
    const f = await fresh();
    const run = await mkRun(f);
    const r = await store.withRunLocked(
      f.scope,
      run.id,
      async (_tx, locked) => locked.steps.length,
    );
    expect(r).toBe(1);
    const other = await fresh();
    expect(await store.withRunLocked(other.scope, run.id, async () => 'x')).toBeNull();
  });
});

describe('settleStep', () => {
  it('only moves pending steps', async () => {
    const f = await fresh();
    const run = await mkRun(f);
    const id = run.steps[0]!.id;
    await settle(f, id, 'succeeded');
    await settle(f, id, 'failed');
    const s = await store.loadStep(f.scope, id);
    expect(s).toMatchObject({ status: 'succeeded', reasonCode: null });
    expect(s!.completedAt).toBeInstanceOf(Date);
  });

  it('stores simulated previews and review links', async () => {
    const f = await fresh();
    const run = await mkRun(f, [FLAG, REPLY], { dryRun: true });
    await withTransaction(pool, (tx) =>
      store.settleStep(tx, f.scope, run.steps[1]!.id, {
        status: 'simulated',
        reason: null,
        previewText: 'Thanks',
      }),
    );
    expect((await store.loadStep(f.scope, run.steps[1]!.id))!.previewText).toBe('Thanks');
  });
});

describe('linkAction', () => {
  it('second step with same action id -> owned_by_other_step', async () => {
    const f = await fresh();
    const run1 = await mkRun(f, [HIDE]);
    const run2 = await mkRun(f, [HIDE]);
    const action = await seedModerationActionRow(ctx.c, f.comment, { kind: 'hide' });
    const link = (stepId: string, key: string) =>
      withTransaction(pool, (tx) => store.linkAction(tx, f.scope, stepId, action, key));
    expect(await link(run1.steps[0]!.id, 'rk-1')).toBe('linked');
    expect(await link(run2.steps[0]!.id, 'rk-2')).toBe('owned_by_other_step');
    expect(await store.findStepByAction(f.scope, action)).toEqual({
      runId: run1.id,
      stepId: run1.steps[0]!.id,
      connectionId: f.t.connectionId,
    });
    const s = await store.loadStep(f.scope, run1.steps[0]!.id);
    expect(s).toMatchObject({ moderationActionId: action, requestKey: 'rk-1' });
  });

  it('keeps the surrounding transaction usable after a conflict', async () => {
    const f = await fresh();
    const run1 = await mkRun(f, [HIDE]);
    const run2 = await mkRun(f, [HIDE]);
    const action = await seedModerationActionRow(ctx.c, f.comment, { kind: 'hide' });
    await withTransaction(pool, (tx) =>
      store.linkAction(tx, f.scope, run1.steps[0]!.id, action, 'a'),
    );
    await withTransaction(pool, async (tx) => {
      expect(await store.linkAction(tx, f.scope, run2.steps[0]!.id, action, 'b')).toBe(
        'owned_by_other_step',
      );
      await store.settleStep(tx, f.scope, run2.steps[0]!.id, { status: 'skipped', reason: 'dup' });
    });
    expect((await store.loadStep(f.scope, run2.steps[0]!.id))!.status).toBe('skipped');
  });
});

describe('markRunCompleted', () => {
  it('sets completed_at', async () => {
    const f = await fresh();
    const run = await mkRun(f);
    await withTransaction(pool, (tx) => store.markRunCompleted(tx, f.scope, run.id));
    const again = await store.withRunLocked(f.scope, run.id, async (_tx, r) => r);
    expect(again!.completedAt).toBeInstanceOf(Date);
  });
});

describe('markUndone', () => {
  it('records once and returns false the second time', async () => {
    const f = await fresh();
    const run = await mkRun(f);
    await settle(f, run.steps[0]!.id);
    expect(await undo(f, run.steps[0]!.id)).toBe(true);
    expect(await undo(f, run.steps[0]!.id)).toBe(false);
    expect((await store.loadStep(f.scope, run.steps[0]!.id))!.undoneAt).toBeInstanceOf(Date);
  });

  it('only marks succeeded, live hide, ban and flag steps', async () => {
    const f = await fresh();
    const run = await mkRun(f, [FLAG, REPLY, HIDE, BAN]);
    const [flag, reply, hide, ban] = run.steps;
    await settle(f, hide!.id, 'failed');
    await settle(f, reply!.id);
    expect(await undo(f, hide!.id)).toBe(false);
    expect(await undo(f, reply!.id)).toBe(false);
    expect(await undo(f, ban!.id)).toBe(false);
    await settle(f, flag!.id);
    expect(await undo(f, flag!.id)).toBe(true);

    const dry = await mkRun(f, [HIDE], { dryRun: true });
    await settle(f, dry.steps[0]!.id);
    expect(await undo(f, dry.steps[0]!.id)).toBe(false);
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);
  });
});

describe('hasUserReversal', () => {
  it('user unhide after automated hide -> true; automated re-hide after user unhide -> false', async () => {
    const f = await fresh();
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);
    await seedModerationActionRow(ctx.c, f.comment, {
      kind: 'hide',
      actorType: 'rule',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);
    await seedModerationActionRow(ctx.c, f.comment, {
      kind: 'unhide',
      actorType: 'user',
      createdAt: '2026-01-02T00:00:00Z',
    });
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(true);
    await seedModerationActionRow(ctx.c, f.comment, {
      kind: 'hide',
      actorType: 'rule',
      createdAt: '2026-01-03T00:00:00Z',
    });
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);
  });

  it('ignores failed actions and automated unhides', async () => {
    const f = await fresh();
    await seedModerationActionRow(ctx.c, f.comment, {
      kind: 'unhide',
      actorType: 'user',
      status: 'failed',
    });
    await seedModerationActionRow(ctx.c, f.comment, { kind: 'unhide', actorType: 'rule' });
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);
  });

  it('counts an undone hide step as a reversal', async () => {
    const f = await fresh();
    const run = await mkRun(f, [HIDE]);
    await settle(f, run.steps[0]!.id);
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);
    await undo(f, run.steps[0]!.id);
    expect(await store.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(true);
  });

  it('ban reversal is per author across comments', async () => {
    const f = await fresh();
    const c1 = await seedCommentRow(ctx.c, f.t, 'one', { authorId: f.t.authorId });
    const c2 = await seedCommentRow(ctx.c, f.t, 'two', { authorId: f.t.authorId });
    const c3 = await seedCommentRow(ctx.c, f.t, 'three');
    await seedModerationActionRow(ctx.c, c1, {
      kind: 'ban_author',
      actorType: 'rule',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await seedModerationActionRow(ctx.c, c1, {
      kind: 'unban_author',
      actorType: 'user',
      createdAt: '2026-01-02T00:00:00Z',
    });
    expect(await store.hasUserReversal(f.scope, c2.id, 'ban_author')).toBe(true);
    expect(await store.hasUserReversal(f.scope, c3.id, 'ban_author')).toBe(false);
    expect(await store.hasUserReversal(f.scope, c2.id, 'hide')).toBe(false);
  });

  it('ban reversal via an undone ban step on a sibling comment', async () => {
    const f = await fresh();
    const c1 = await seedCommentRow(ctx.c, f.t, 'one', { authorId: f.t.authorId });
    const c2 = await seedCommentRow(ctx.c, f.t, 'two', { authorId: f.t.authorId });
    const run = await mkRun(f, [BAN], { comment: c1 });
    await settle(f, run.steps[0]!.id);
    await undo(f, run.steps[0]!.id);
    expect(await store.hasUserReversal(f.scope, c2.id, 'ban_author')).toBe(true);
  });
});

describe('hasAutomatedThreadReply', () => {
  it('sees a sibling reply under the same parent', async () => {
    const f = await fresh();
    const root = await seedCommentRow(ctx.c, f.t, 'root');
    const a = await seedCommentRow(ctx.c, f.t, 'a', { parentId: root.id });
    const b = await seedCommentRow(ctx.c, f.t, 'b', { parentId: root.id });
    expect(await store.hasAutomatedThreadReply(f.scope, b.id)).toBe(false);
    await seedModerationActionRow(ctx.c, a, { kind: 'public_reply', actorType: 'user' });
    expect(await store.hasAutomatedThreadReply(f.scope, b.id)).toBe(false);
    await seedModerationActionRow(ctx.c, a, {
      kind: 'public_reply',
      actorType: 'rule',
      status: 'failed',
    });
    expect(await store.hasAutomatedThreadReply(f.scope, b.id)).toBe(false);
    await seedModerationActionRow(ctx.c, a, { kind: 'public_reply', actorType: 'rule' });
    expect(await store.hasAutomatedThreadReply(f.scope, b.id)).toBe(true);
    expect(await store.hasAutomatedThreadReply(f.scope, root.id)).toBe(true);
    const other = await seedCommentRow(ctx.c, f.t, 'other');
    expect(await store.hasAutomatedThreadReply(f.scope, other.id)).toBe(false);
  });
});

describe('listLog', () => {
  it("filters and never returns another brand's steps", async () => {
    const f = await fresh();
    const g = await fresh();
    const run = await mkRun(f, [FLAG, HIDE]);
    await settle(f, run.steps[0]!.id);
    await settle(f, run.steps[1]!.id, 'failed');
    const dry = await mkRun(f, [HIDE], { dryRun: true });
    await mkRun(g, [HIDE]);

    const all = await store.listLog(f.scope, { limit: 50 });
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.ruleName === 'Scam links')).toBe(true);
    expect(await store.listLog(g.scope, { limit: 50 })).toHaveLength(1);

    const failed = await store.listLog(f.scope, { limit: 50, status: 'failed' });
    expect(failed.map((e) => e.type)).toEqual(['hide']);
    expect(failed[0]!.undoable).toBe(false);
    const flagged = await store.listLog(f.scope, { limit: 50, type: 'flag_for_review' });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.undoable).toBe(true);
    expect(await store.listLog(f.scope, { limit: 50, commentId: f.comment.id })).toHaveLength(3);
    expect(await store.listLog(f.scope, { limit: 50, ruleId: f.t.ruleId })).toHaveLength(3);
    expect(await store.listLog(f.scope, { limit: 50, ruleId: g.t.ruleId })).toHaveLength(0);
    const dryEntry = all.find((e) => e.runId === dry.id);
    expect(dryEntry).toMatchObject({ dryRun: true, undoable: false });
    expect(await store.listLog(f.scope, { limit: 1 })).toHaveLength(1);
  });

  it('undoable is a boolean on every row, and false for an undone flag step', async () => {
    const f = await fresh();
    const run = await mkRun(f, [FLAG, HIDE]);
    await settle(f, run.steps[0]!.id);
    await settle(f, run.steps[1]!.id);
    await undo(f, run.steps[0]!.id);
    await undo(f, run.steps[1]!.id);
    const all = await store.listLog(f.scope, { limit: 50 });
    expect(all.map((e) => [e.type, e.undoable])).toEqual([
      ['hide', false],
      ['flag_for_review', false],
    ]);
  });

  it('clamps the limit and orders the steps of a run by position', async () => {
    const f = await fresh();
    await mkRun(f, [FLAG, REPLY, HIDE]);
    expect(await store.listLog(f.scope, { limit: 0 })).toHaveLength(1);
    expect(await store.listLog(f.scope, { limit: -5 })).toHaveLength(1);
    expect(await store.listLog(f.scope, { limit: 1e9 })).toHaveLength(3);
    const all = await store.listLog(f.scope, { limit: 10 });
    expect(all.map((e) => e.position)).toEqual([2, 1, 0]);
    const rest = await store.listLog(f.scope, { limit: 10, before: all[0]!.id });
    expect(rest.map((e) => e.position)).toEqual([1, 0]);
  });

  it('pages with a before cursor and reports action statuses', async () => {
    const f = await fresh();
    const runs: Awaited<ReturnType<typeof mkRun>>[] = [];
    for (let i = 0; i < 3; i++) runs.push(await mkRun(f, [HIDE]));
    const first = await store.listLog(f.scope, { limit: 2 });
    expect(first).toHaveLength(2);
    const rest = await store.listLog(f.scope, { limit: 2, before: first[1]!.id });
    expect(rest).toHaveLength(1);
    expect(new Set([...first, ...rest].map((e) => e.id)).size).toBe(3);

    const action = await seedModerationActionRow(ctx.c, f.comment, {
      kind: 'hide',
      status: 'applied',
    });
    await withTransaction(pool, (tx) =>
      store.linkAction(tx, f.scope, runs[0]!.steps[0]!.id, action, 'k'),
    );
    const entry = (await store.listLog(f.scope, { limit: 10 })).find(
      (e) => e.id === runs[0]!.steps[0]!.id,
    );
    expect(entry).toMatchObject({ actionStatus: 'applied', undoStatus: null });
  });
});

describe('cross-brand isolation', () => {
  it('every method called with brand B scope returns null/empty/false for brand A ids', async () => {
    const a = await fresh();
    const b = await fresh();
    const run = await mkRun(a, [HIDE, BAN]);
    const stepId = run.steps[0]!.id;
    const action = await seedModerationActionRow(ctx.c, a.comment, { kind: 'hide' });
    await seedModerationActionRow(ctx.c, a.comment, { kind: 'unhide', actorType: 'user' });
    await seedModerationActionRow(ctx.c, a.comment, { kind: 'public_reply', actorType: 'rule' });

    expect(await store.withRunLocked(b.scope, run.id, async () => 'x')).toBeNull();
    expect(await store.loadStep(b.scope, stepId)).toBeNull();
    expect(await store.findStepByAction(b.scope, action)).toBeNull();
    expect(await store.hasUserReversal(b.scope, a.comment.id, 'hide')).toBe(false);
    expect(await store.hasAutomatedThreadReply(b.scope, a.comment.id)).toBe(false);
    expect(await store.listLog(b.scope, { limit: 10, commentId: a.comment.id })).toEqual([]);

    // Writes under brand B's scope must not touch brand A's rows.
    await expect(
      withTransaction(pool, (tx) => store.linkAction(tx, b.scope, stepId, action, 'x')),
    ).rejects.toThrow('step_not_found');
    await withTransaction(pool, async (tx) => {
      await store.settleStep(tx, b.scope, stepId, { status: 'succeeded', reason: null });
      await store.markRunCompleted(tx, b.scope, run.id);
      expect(await store.markUndone(tx, b.scope, stepId, b.t.userId, null)).toBe(false);
    });
    const s = await store.loadStep(a.scope, stepId);
    expect(s).toMatchObject({ status: 'pending', moderationActionId: null, undoneAt: null });
    expect(
      (await store.withRunLocked(a.scope, run.id, async (_t, r) => r))!.completedAt,
    ).toBeNull();
  });
});

describe('listLog for approval runs', () => {
  it('shows approval-run steps with a null rule and the suggestion id', async () => {
    const f = await fresh();
    const suggestionId = await seedSuggestionRow(ctx.c, f.comment);
    await withTransaction(pool, (tx) =>
      store.createSuggestionRun(tx, f.scope, {
        suggestionId,
        commentId: f.comment.id,
        userId: f.t.userId,
        steps: [{ type: 'hide' }],
      }),
    );
    await mkRun(f, [HIDE]);
    const all = await store.listLog(f.scope, { limit: 50 });
    const approval = all.find((e) => e.suggestionId === suggestionId)!;
    expect(approval).toMatchObject({ ruleId: null, ruleName: null, type: 'hide' });
    expect(all.find((e) => e.suggestionId === null)).toMatchObject({ ruleName: 'Scam links' });
  });
});
