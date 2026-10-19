import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector } from '@feedbouncer/connector-instagram';
import { ModerationActions, PgCommentStore } from '@feedbouncer/comments';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgReviewQueue } from './review.js';
import { PgActionRunStore } from './runs.js';
import { resolveReviewItem, undoStep, type Audit } from './services.js';
import type { ActionStep, StepType } from './steps.js';
import { scopeOf, seedCommentRow, seedEvaluationRow, seedModerationActionRow } from './testing.js';

const META = {
  appId: '111',
  appSecret: new Secret('fb-app-secret-0123456789'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('v'.repeat(24)),
};
const IG_ACCOUNT = '17841400000000001';
const facebook = createFacebookConnector(META).capabilities;
const instagram = createInstagramConnector({ meta: META }).capabilities;

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let runs: PgActionRunStore;
let review: PgReviewQueue;
let comments: PgCommentStore;
let enqueue: ReturnType<typeof vi.fn>;
let actions: ModerationActions;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'actions-services-test',
    onIdleError: () => {},
  });
  runs = new PgActionRunStore(pool);
  review = new PgReviewQueue(pool);
  comments = new PgCommentStore(pool);
  enqueue = vi.fn(async () => ({ status: 'enqueued', ledgerId: 'l', jobId: 'j' }));
  actions = new ModerationActions({
    pool,
    store: comments,
    producer: { enqueue } as never,
    capabilities: (p) => (p === 'facebook' ? facebook : p === 'instagram' ? instagram : undefined),
    clock: { now: () => Date.now() },
    log: createLogger('actions-services-test', 'error', () => {}),
  });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const fresh = async (state = 'visible', withAuthor = false) => {
  const t = await seedTenant(ctx.c, `sv${++n}`);
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    `page-${n}`,
    t.connectionId,
  ]);
  const comment = await seedCommentRow(ctx.c, t, 'hello', {
    state,
    ...(withAuthor ? { authorId: t.authorId } : {}),
  });
  return { t, comment, scope: scopeOf(t) };
};
type F = Awaited<ReturnType<typeof fresh>>;

/** Stands in for the API's recordAudit, which the services receive. */
const audit: Audit = async (tx, e) => {
  await tx.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action,
                              subject_type, subject_id, details)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, $7::jsonb)`,
    [e.organizationId, e.brandId, e.actorUserId, e.action, e.subjectType, e.subjectId, e.details],
  );
};
const deps = () => ({ pool, runs, review, comments, actions, audit });

/** A settled step; hide and ban steps are linked to an applied rule action. */
async function seedStep(
  f: F,
  step: ActionStep,
  o: { dryRun?: boolean; status?: 'succeeded' | 'failed' } = {},
) {
  const run = await runs.createRun(f.scope, {
    commentId: f.comment.id,
    ruleId: f.t.ruleId,
    evaluationId: await seedEvaluationRow(ctx.c, f.comment),
    dryRun: o.dryRun ?? false,
    steps: [step],
  });
  const s = run.steps[0]!;
  const kinds: Partial<Record<StepType, string>> = {
    hide: 'hide',
    ban: 'ban_author',
    delete: 'delete',
  };
  const kind = kinds[step.type];
  const actionId = kind ? await seedModerationActionRow(ctx.c, f.comment, { kind }) : null;
  let reviewItemId: string | undefined;
  await withTransaction(pool, async (tx) => {
    if (actionId) await runs.linkAction(tx, f.scope, s.id, actionId, `auto:${s.id}`);
    if (step.type === 'flag_for_review')
      reviewItemId = (
        await review.open(tx, f.scope, {
          commentId: f.comment.id,
          source: 'action_step',
          ruleId: f.t.ruleId,
        })
      ).id;
    await runs.settleStep(tx, f.scope, s.id, {
      status: o.status ?? 'succeeded',
      reason: null,
      ...(reviewItemId ? { reviewItemId } : {}),
    });
  });
  return { stepId: s.id, actionId, reviewItemId };
}

const openItem = (f: F, commentId = f.comment.id) =>
  withTransaction(
    pool,
    async (tx) =>
      (await review.open(tx, f.scope, { commentId, source: 'action_step', ruleId: f.t.ruleId })).id,
  );
const actionRows = async (commentId: string) =>
  (
    await pool.query(
      `SELECT id, kind, actor_type, request_key, reverses_action_id FROM moderation_action
        WHERE comment_id = $1 ORDER BY created_at, id`,
      [commentId],
    )
  ).rows;
const auditRows = async (action: string, f: F) =>
  (
    await pool.query(
      `SELECT actor_user_id, subject_id, details FROM audit_event
        WHERE organization_id = $1 AND action = $2`,
      [f.t.organizationId, action],
    )
  ).rows;

describe('undoStep', () => {
  it('undo hide requests unhide with reverses_action_id and marks the step undone', async () => {
    const f = await fresh('hidden');
    const { stepId, actionId } = await seedStep(f, { type: 'hide' });
    const r = await undoStep(deps(), f.scope, stepId, f.t.userId);
    expect(r).toMatchObject({ status: 'accepted', undoActionId: expect.any(String) });

    const rows = await actionRows(f.comment.id);
    const unhide = rows.find((a) => a.kind === 'unhide');
    expect(unhide).toMatchObject({
      actor_type: 'user',
      request_key: `undo:${stepId}`,
      reverses_action_id: actionId,
    });
    const step = await runs.loadStep(f.scope, stepId);
    expect(step).toMatchObject({ undoActionId: unhide.id });
    expect(step!.undoneAt).toBeInstanceOf(Date);
    const audit = await auditRows('action_step.undone', f);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: f.t.userId,
      subject_id: stepId,
      details: { stepId, type: 'hide', undoActionId: unhide.id },
    });
  });

  it('undo ban requests unban_author', async () => {
    const f = await fresh('visible', true);
    const { stepId, actionId } = await seedStep(f, { type: 'ban', confirmHardToReverse: true });
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toMatchObject({
      status: 'accepted',
    });
    expect((await actionRows(f.comment.id)).find((a) => a.kind === 'unban_author')).toMatchObject({
      reverses_action_id: actionId,
      request_key: `undo:${stepId}`,
    });
  });

  it('undo of a flag whose item was already resolved is refused and not offered', async () => {
    const f = await fresh();
    const { stepId, reviewItemId } = await seedStep(f, { type: 'flag_for_review' });
    expect((await runs.listLog(f.scope, { limit: 10 }))[0]).toMatchObject({ undoable: true });
    await withTransaction(pool, (tx) =>
      review.resolve(tx, f.scope, reviewItemId!, {
        resolution: 'deleted',
        userId: f.t.userId,
        actionId: null,
      }),
    );
    expect((await runs.listLog(f.scope, { limit: 10 }))[0]).toMatchObject({ undoable: false });
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toEqual({
      status: 'refused',
      code: 'undo_not_available',
    });
    expect((await runs.loadStep(f.scope, stepId))!.undoneAt).toBeNull();
    expect(await auditRows('action_step.undone', f)).toEqual([]);
  });

  it('undo twice -> already_undone, with one unhide', async () => {
    const f = await fresh('hidden');
    const { stepId } = await seedStep(f, { type: 'hide' });
    await undoStep(deps(), f.scope, stepId, f.t.userId);
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toEqual({
      status: 'refused',
      code: 'already_undone',
    });
    expect((await actionRows(f.comment.id)).filter((a) => a.kind === 'unhide')).toHaveLength(1);
    expect(await auditRows('action_step.undone', f)).toHaveLength(1);
  });

  it('a retry after the request went through but the step was not marked reuses the action', async () => {
    const f = await fresh('hidden');
    const { stepId, actionId } = await seedStep(f, { type: 'hide' });
    const first = await actions.request({
      scope: f.scope,
      commentId: f.comment.id,
      kind: 'unhide',
      actor: { type: 'user', userId: f.t.userId },
      requestKey: `undo:${stepId}`,
      reverses: actionId!,
    });
    const r = await undoStep(deps(), f.scope, stepId, f.t.userId);
    expect(r).toMatchObject({
      status: 'accepted',
      undoActionId: (first as { action: { id: string } }).action.id,
    });
    expect((await actionRows(f.comment.id)).filter((a) => a.kind === 'unhide')).toHaveLength(1);
  });

  it('an undo that later fails on the platform shows in the log and can be retried', async () => {
    const f = await fresh('hidden');
    const { stepId } = await seedStep(f, { type: 'hide' });
    const first = await undoStep(deps(), f.scope, stepId, f.t.userId);
    if (first.status === 'refused') throw new Error('undo refused');
    expect(await runs.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(true);
    // A second click while the unhide is pending stays one request.
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toEqual({
      status: 'refused',
      code: 'already_undone',
    });

    await ctx.c.query(
      `UPDATE moderation_action SET status = 'failed', outcome_code = 'platform_error',
              completed_at = now() WHERE id = $1`,
      [first.undoActionId],
    );
    const [entry] = await runs.listLog(f.scope, { commentId: f.comment.id, limit: 10 });
    expect(entry).toMatchObject({ id: stepId, undoStatus: 'failed', undoable: true });
    // The failed unhide is no moderator override: automation may still hide the comment.
    expect(await runs.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);

    const retry = await undoStep(deps(), f.scope, stepId, f.t.userId);
    expect(retry).toMatchObject({ status: 'accepted' });
    if (retry.status === 'refused') throw new Error('retry refused');
    expect(retry.undoActionId).not.toBe(first.undoActionId);
    const unhides = (await actionRows(f.comment.id)).filter((a) => a.kind === 'unhide');
    expect(unhides.map((a) => a.request_key)).toEqual([
      `undo:${stepId}`,
      `undo:${stepId}:${first.undoActionId}`,
    ]);
    const step = await runs.loadStep(f.scope, stepId);
    expect(step).toMatchObject({ undoActionId: retry.undoActionId, undoStatus: 'pending' });
    expect(step!.undoneAt).toBeInstanceOf(Date);
    expect(await runs.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(true);
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toEqual({
      status: 'refused',
      code: 'already_undone',
    });
  });

  it('concurrent retries of a failed undo make one new request and both succeed', async () => {
    const f = await fresh('hidden');
    const { stepId } = await seedStep(f, { type: 'hide' });
    const first = await undoStep(deps(), f.scope, stepId, f.t.userId);
    if (first.status === 'refused') throw new Error('undo refused');
    await ctx.c.query(
      `UPDATE moderation_action SET status = 'failed', completed_at = now() WHERE id = $1`,
      [first.undoActionId],
    );
    const [a, b] = await Promise.all([
      undoStep(deps(), f.scope, stepId, f.t.userId),
      undoStep(deps(), f.scope, stepId, f.t.userId),
    ]);
    const ok = [a, b].filter((r) => r.status === 'accepted');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b])
      if (r.status !== 'refused') expect(r).toEqual(ok[0]);
      else expect(r.code).toBe('already_undone');
    expect((await actionRows(f.comment.id)).filter((x) => x.kind === 'unhide')).toHaveLength(2);
  });

  it('an undo the platform refuses at once is recorded, not marked, and can be retried', async () => {
    const f = await fresh('hidden');
    const { stepId } = await seedStep(f, { type: 'hide' });
    const refusedId = await seedModerationActionRow(ctx.c, f.comment, {
      kind: 'unhide',
      actorType: 'user',
      status: 'not_eligible',
    });
    const once = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'recorded',
          action: { id: refusedId, status: 'not_eligible' },
        })
        .mockImplementation((i) => actions.request(i)),
    };
    const d = { ...deps(), actions: once };
    expect(await undoStep(d, f.scope, stepId, f.t.userId)).toEqual({
      status: 'refused',
      code: 'undo_not_available',
    });
    const step = await runs.loadStep(f.scope, stepId);
    expect(step).toMatchObject({ undoneAt: null, undoActionId: refusedId });
    expect(await runs.hasUserReversal(f.scope, f.comment.id, 'hide')).toBe(false);
    expect((await runs.listLog(f.scope, { commentId: f.comment.id, limit: 10 }))[0]).toMatchObject({
      undoStatus: 'not_eligible',
      undoable: true,
    });

    expect(await undoStep(d, f.scope, stepId, f.t.userId)).toMatchObject({ status: 'accepted' });
    expect(once.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestKey: `undo:${stepId}:${refusedId}` }),
    );
    expect((await runs.loadStep(f.scope, stepId))!.undoneAt).toBeInstanceOf(Date);
  });

  it.each([
    ['delete', { type: 'delete', confirmIrreversible: true }],
    ['auto_reply', { type: 'auto_reply', template: 'Thanks' }],
    ['private_reply', { type: 'private_reply', template: 'Hello' }],
  ] as const)('undo %s -> undo_not_available', async (_n, step) => {
    const f = await fresh();
    const { stepId } = await seedStep(f, step);
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toEqual({
      status: 'refused',
      code: 'undo_not_available',
    });
    expect((await runs.loadStep(f.scope, stepId))!.undoneAt).toBeNull();
  });

  it('undo of a dry-run or failed step -> undo_not_available', async () => {
    const f = await fresh('hidden');
    const dry = await seedStep(f, { type: 'hide' }, { dryRun: true });
    const failed = await seedStep(f, { type: 'hide' }, { status: 'failed' });
    for (const s of [dry, failed])
      expect(await undoStep(deps(), f.scope, s.stepId, f.t.userId)).toEqual({
        status: 'refused',
        code: 'undo_not_available',
      });
    expect(await actionRows(f.comment.id)).toHaveLength(2);
  });

  it('undo flag dismisses the open review item', async () => {
    const f = await fresh();
    const { stepId, reviewItemId } = await seedStep(f, { type: 'flag_for_review' });
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toEqual({
      status: 'done',
      undoActionId: null,
    });
    expect(await review.load(f.scope, reviewItemId!)).toMatchObject({
      status: 'resolved',
      resolution: 'dismissed',
    });
    expect((await runs.loadStep(f.scope, stepId))!.undoneAt).toBeInstanceOf(Date);
    expect(await auditRows('action_step.undone', f)).toHaveLength(1);
  });

  it('undo from another brand -> not_found, nothing changes', async () => {
    const f = await fresh('hidden');
    const g = await fresh();
    const { stepId } = await seedStep(f, { type: 'hide' });
    expect(await undoStep(deps(), g.scope, stepId, g.t.userId)).toEqual({
      status: 'refused',
      code: 'not_found',
    });
    expect(await undoStep(deps(), f.scope, 'not-a-uuid', f.t.userId)).toEqual({
      status: 'refused',
      code: 'not_found',
    });
    expect((await runs.loadStep(f.scope, stepId))!.undoneAt).toBeNull();
    expect(await actionRows(f.comment.id)).toHaveLength(1);
  });

  it('undo hide on a connection that needs reconnecting -> refused, step stays undoable', async () => {
    const f = await fresh('hidden');
    const { stepId } = await seedStep(f, { type: 'hide' });
    await ctx.c.query(`UPDATE connection SET status = 'reconnect_required' WHERE id = $1`, [
      f.t.connectionId,
    ]);
    expect(await undoStep(deps(), f.scope, stepId, f.t.userId)).toEqual({
      status: 'refused',
      code: 'connection_needs_reconnect',
    });
    expect((await runs.loadStep(f.scope, stepId))!.undoneAt).toBeNull();
  });
});

describe('resolveReviewItem', () => {
  const resolve = (
    f: F,
    itemId: string,
    resolution: 'approve' | 'hide' | 'delete' | 'ban',
    o: { requestKey?: string; confirm?: boolean } = {},
  ) =>
    resolveReviewItem(deps(), f.scope, itemId, {
      resolution,
      userId: f.t.userId,
      requestKey: o.requestKey ?? `rk-${randomUUID()}`,
      ...(o.confirm !== undefined ? { confirm: o.confirm } : {}),
    });

  it('hide requests the action with the client key and resolves the item', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    const requestKey = `rk-${randomUUID()}`;
    const r = await resolve(f, itemId, 'hide', { requestKey });
    expect(r).toMatchObject({ status: 'resolved', actionId: expect.any(String) });
    expect(await actionRows(f.comment.id)).toMatchObject([
      { kind: 'hide', actor_type: 'user', request_key: requestKey },
    ]);
    expect(await review.load(f.scope, itemId)).toMatchObject({
      status: 'resolved',
      resolution: 'hidden',
    });
    const audit = await auditRows('review_item.resolved', f);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: f.t.userId,
      subject_id: itemId,
      details: { itemId, resolution: 'hidden', actionId: (r as { actionId: string }).actionId },
    });
  });

  it('resolve delete without confirm -> confirmation_required, item stays open', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    for (const resolution of ['delete', 'ban'] as const)
      for (const confirm of [undefined, false])
        expect(
          await resolve(f, itemId, resolution, confirm === undefined ? {} : { confirm }),
        ).toEqual({ status: 'refused', code: 'confirmation_required' });
    expect((await review.load(f.scope, itemId))!.status).toBe('open');
    expect(await actionRows(f.comment.id)).toEqual([]);
  });

  it('delete and ban with confirm resolve as deleted and banned', async () => {
    const f = await fresh();
    const g = await fresh('visible', true);
    const del = await resolve(f, await openItem(f), 'delete', { confirm: true });
    const ban = await resolve(g, await openItem(g), 'ban', { confirm: true });
    expect(del.status).toBe('resolved');
    expect(ban.status).toBe('resolved');
    expect((await actionRows(f.comment.id))[0]!.kind).toBe('delete');
    expect((await actionRows(g.comment.id))[0]!.kind).toBe('ban_author');
    expect((await auditRows('review_item.resolved', f))[0]!.details).toMatchObject({
      resolution: 'deleted',
    });
  });

  it('resolve ban on instagram -> unsupported, item stays open', async () => {
    const f = await fresh();
    const ig = await pool.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'instagram', $3) RETURNING id`,
      [f.t.organizationId, f.t.brandId, IG_ACCOUNT + n],
    );
    const igScope = { ...f.scope, connectionId: ig.rows[0]!.id };
    const { commentId } = await comments.upsertFromPlatform(
      igScope,
      {
        externalId: `ig-${randomUUID()}`,
        sourceExternalId: '17900000000000001',
        parentExternalId: null,
        author: { externalId: '178414990000000001', displayName: 'someone', profileUrl: null },
        body: 'hello',
        postedAt: new Date(Date.now() - 60_000),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: IG_ACCOUNT + n, syncedAt: new Date() },
    );
    const itemId = await withTransaction(
      pool,
      async (tx) =>
        (await review.open(tx, igScope, { commentId, source: 'action_step', ruleId: f.t.ruleId }))
          .id,
    );
    expect(await resolve(f, itemId, 'ban', { confirm: true })).toEqual({
      status: 'refused',
      code: 'unsupported',
    });
    expect((await review.load(f.scope, itemId))!.status).toBe('open');
  });

  it('a refused request leaves the item open', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    await ctx.c.query(`UPDATE connection SET status = 'reconnect_required' WHERE id = $1`, [
      f.t.connectionId,
    ]);
    expect(await resolve(f, itemId, 'hide')).toEqual({
      status: 'refused',
      code: 'connection_needs_reconnect',
    });
    expect((await review.load(f.scope, itemId))!.status).toBe('open');
  });

  it('approve of an auto-hidden comment unhides it', async () => {
    const f = await fresh('hidden');
    await seedModerationActionRow(ctx.c, f.comment, { kind: 'hide', actorType: 'rule' });
    const itemId = await openItem(f);
    const r = await resolve(f, itemId, 'approve');
    expect(r).toMatchObject({ status: 'resolved', actionId: expect.any(String) });
    expect((await actionRows(f.comment.id)).find((a) => a.kind === 'unhide')).toMatchObject({
      actor_type: 'user',
      request_key: `review:${itemId}:unhide`,
    });
    expect(await review.load(f.scope, itemId)).toMatchObject({ resolution: 'approved' });
  });

  it('approve leaves a comment a person hid alone', async () => {
    const f = await fresh('hidden');
    await seedModerationActionRow(ctx.c, f.comment, { kind: 'hide', actorType: 'user' });
    const itemId = await openItem(f);
    expect(await resolve(f, itemId, 'approve')).toEqual({ status: 'resolved', actionId: null });
    expect(await actionRows(f.comment.id)).toHaveLength(1);
  });

  it('approve leaves a comment an API key hid alone', async () => {
    const f = await fresh('hidden');
    await seedModerationActionRow(ctx.c, f.comment, { kind: 'hide', actorType: 'api_key' });
    const itemId = await openItem(f);
    expect(await resolve(f, itemId, 'approve')).toEqual({ status: 'resolved', actionId: null });
    expect(await actionRows(f.comment.id)).toHaveLength(1);
  });

  it('approve of a visible comment only resolves the item', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    expect(await resolve(f, itemId, 'approve')).toEqual({ status: 'resolved', actionId: null });
    expect(await actionRows(f.comment.id)).toEqual([]);
  });

  it('double-submit with the same requestKey -> one action', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    const requestKey = `rk-${randomUUID()}`;
    const results = await Promise.all([
      resolve(f, itemId, 'hide', { requestKey }),
      resolve(f, itemId, 'hide', { requestKey }),
    ]);
    expect(results.filter((r) => r.status === 'resolved')).toHaveLength(1);
    expect(await actionRows(f.comment.id)).toHaveLength(1);
    expect(await resolve(f, itemId, 'hide', { requestKey })).toEqual({
      status: 'refused',
      code: 'review_item_resolved',
    });
  });

  it('concurrent resolutions with different keys run one action and refuse the other', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    const results = await Promise.all([
      resolve(f, itemId, 'hide'),
      resolve(f, itemId, 'delete', { confirm: true }),
    ]);
    expect(results.filter((r) => r.status === 'resolved')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'refused')).toEqual([
      { status: 'refused', code: 'review_item_resolved' },
    ]);
    expect(await actionRows(f.comment.id)).toHaveLength(1);
  });

  it('concurrent resolves on a pool no larger than their number do not hang', async () => {
    const small = createPool(ctx.db.url, {
      applicationName: 'actions-services-small',
      max: 3,
      onIdleError: () => {},
    });
    try {
      const smallComments = new PgCommentStore(small);
      const smallActions = new ModerationActions({
        pool: small,
        store: smallComments,
        producer: { enqueue } as never,
        capabilities: (p) => (p === 'facebook' ? facebook : undefined),
        clock: { now: () => Date.now() },
        log: createLogger('actions-services-small', 'error', () => {}),
      });
      const fs = [await fresh(), await fresh(), await fresh()];
      const items = await Promise.all(fs.map((f) => openItem(f)));
      const results = await Promise.all(
        fs.map((f, k) =>
          resolveReviewItem(
            {
              pool: small,
              review: new PgReviewQueue(small),
              comments: smallComments,
              actions: smallActions,
              audit,
            },
            f.scope,
            items[k]!,
            { resolution: 'hide', userId: f.t.userId, requestKey: `rk-${randomUUID()}` },
          ),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(['resolved', 'resolved', 'resolved']);
    } finally {
      await small.end();
    }
  }, 15_000);

  it('a retry with the same key after the resolution failed reuses the queued action', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    const requestKey = `rk-${randomUUID()}`;
    const failing: Audit = async () => {
      throw new Error('audit down');
    };
    await expect(
      resolveReviewItem({ ...deps(), audit: failing }, f.scope, itemId, {
        resolution: 'hide',
        userId: f.t.userId,
        requestKey,
      }),
    ).rejects.toThrow('audit down');
    expect(await review.load(f.scope, itemId)).toMatchObject({ status: 'open' });
    // Another moderator cannot take the item while it is claimed.
    expect(await resolve(f, itemId, 'delete', { confirm: true })).toEqual({
      status: 'refused',
      code: 'review_item_resolved',
    });
    expect(await resolve(f, itemId, 'hide', { requestKey })).toMatchObject({ status: 'resolved' });
    expect(await actionRows(f.comment.id)).toHaveLength(1);
  });

  it('a refused request releases the claim', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    await pool.query("UPDATE connection SET status = 'reconnect_required' WHERE id = $1", [
      f.t.connectionId,
    ]);
    expect((await resolve(f, itemId, 'hide')).status).toBe('refused');
    await ctx.c.query(`UPDATE connection SET status = 'active' WHERE id = $1`, [f.t.connectionId]);
    expect(await resolve(f, itemId, 'hide')).toMatchObject({ status: 'resolved' });
  });

  it('another brand or a malformed id -> not_found', async () => {
    const f = await fresh();
    const g = await fresh();
    const itemId = await openItem(f);
    expect(await resolve(g, itemId, 'hide')).toEqual({ status: 'refused', code: 'not_found' });
    expect(await resolve(f, 'nope', 'hide')).toEqual({ status: 'refused', code: 'not_found' });
    expect((await review.load(f.scope, itemId))!.status).toBe('open');
    expect(await actionRows(f.comment.id)).toEqual([]);
  });

  it.each(['auto:x', 'undo:x', 'review:x'])(
    'rejects the reserved client request key %s and leaves the item open',
    async (requestKey) => {
      const f = await fresh();
      const itemId = await openItem(f);
      await expect(resolve(f, itemId, 'hide', { requestKey })).rejects.toThrow(TypeError);
      expect((await review.load(f.scope, itemId))!.status).toBe('open');
      expect(await actionRows(f.comment.id)).toEqual([]);
    },
  );

  it('rejects a malformed request key or an unknown resolution', async () => {
    const f = await fresh();
    const itemId = await openItem(f);
    await expect(resolve(f, itemId, 'hide', { requestKey: 'bad key!' })).rejects.toThrow(TypeError);
    await expect(resolve(f, itemId, 'purge' as never)).rejects.toThrow(TypeError);
  });
});
