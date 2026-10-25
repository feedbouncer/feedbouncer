// The YouTube write dispatcher over the real connector runtime, the Pg quota
// ledger and FakeYouTube: probe, batched write, settle, restart recovery, dry-run.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectorError, type ConnectionClient } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { INGEST_JOB } from '../jobs/specs.js';
import { CYCLE_LEASE_MS, dispatchPlan, recoverInFlight, type DispatchDeps } from './dispatch.js';
import type { CyclePlan } from './planner.js';
import { pacificDayKey } from './quota-day.js';
import { NOW_MS, youtubeWorld, type YouTubeWorld } from './test-world.js';

const DAY = pacificDayKey(NOW_MS);
const WRITE = 'comments.setModerationStatus';
const PROBE = 'comments.list';
const author = () => `UC${randomUUID().replaceAll('-', '').slice(0, 22)}`;

let w: YouTubeWorld;
beforeAll(async () => {
  w = await youtubeWorld('dispatch');
});
afterAll(() => w.close());
beforeEach(async () => {
  w.reset();
  await w.clearPause();
});

type Client = DispatchDeps['client'];
const deps = async (scope: ConnectionScope, client?: Client): Promise<DispatchDeps> => ({
  pool: w.pool,
  client: client ?? (await w.runtime.connect(scope)),
  backlog: w.backlog,
  ledger: w.ledger,
  producer: w.producer,
  outcomes: w.observer,
  log: w.log,
  clock: w.clock,
});
const live = { dryRun: false, pacificDay: DAY };
const dispatch = async (scope: ConnectionScope, client?: Client, plan?: CyclePlan) =>
  dispatchPlan(await deps(scope, client), scope, plan ?? (await w.plan(scope)), live);
const real = (scope: ConnectionScope): Promise<ConnectionClient> => w.runtime.connect(scope);
const auditOf = async (scope: ConnectionScope, actionId: string) =>
  (await w.audits(scope)).find((a) => a.actionId === actionId)!;
const writeUnits = async (scope: ConnectionScope) =>
  (await w.ledger.dailyTotals(scope, DAY)).find((t) => t.method === WRITE)?.units ?? 0;

describe('dispatchPlan (live)', () => {
  it('applies a ban batch with folded rejects in one write', async () => {
    const c = await w.connect('ban');
    const spammer = author();
    const ban = await w.queuedAction(c, 'ban_author', { author: spammer });
    const reject = await w.queuedAction(c, 'delete', { author: spammer });
    const from = w.fake.calls.length;
    const used = w.fake.unitsUsed;
    const plan = await w.plan(c.scope);
    expect(plan.batches.map((b) => b.items.length)).toEqual([2]);

    expect(await dispatch(c.scope, undefined, plan)).toEqual({
      batchesSent: 1,
      unitsSpent: 51,
      stoppedBy: null,
    });
    expect(w.callsSince(from, WRITE)).toHaveLength(1);
    expect(w.callsSince(from, PROBE)).toHaveLength(1);
    expect(w.fake.unitsUsed - used).toBe(51);
    expect(w.fake.isBanned(spammer)).toBe(true);
    expect(await w.action(ban.actionId)).toEqual({
      status: 'applied',
      outcome_code: null,
      undo_kind: null,
      platform_state: 'deleted',
    });
    expect(await w.action(reject.actionId)).toEqual({
      status: 'applied',
      outcome_code: 'rejected_with_ban',
      undo_kind: null,
      platform_state: 'deleted',
    });
    const audit = await auditOf(c.scope, ban.actionId);
    expect(audit.quota).toEqual({
      units: 51,
      batchSize: 2,
      remainingUnits: 2000 - 51,
      pacificDay: DAY,
      simulated: false,
    });
    expect((await auditOf(c.scope, reject.actionId)).outcomeCode).toBe('rejected_with_ban');
    expect(JSON.stringify(await w.audits(c.scope))).not.toContain('buy followers');
    expect(await w.queue(c.scope)).toEqual([]);
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['confirmed']);
    expect(w.outcomes).toEqual(
      expect.arrayContaining([
        { actionId: ban.actionId, status: 'applied', code: null },
        { actionId: reject.actionId, status: 'applied', code: 'rejected_with_ban' },
      ]),
    );
    expect(await writeUnits(c.scope)).toBe(50);
  });

  it('applies a hold batch with unhide as undo', async () => {
    const c = await w.connect('hold');
    const a = await w.queuedAction(c, 'hide');
    await dispatch(c.scope);
    expect(await w.action(a.actionId)).toEqual({
      status: 'applied',
      outcome_code: null,
      undo_kind: 'unhide',
      platform_state: 'hidden',
    });
    expect(w.fake.comment(a.externalId)?.status).toBe('heldForReview');
  });

  it('skips comments already held, deleted or edited without failing', async () => {
    const c = await w.connect('skips');
    const held = await w.queuedAction(c, 'hide', { fakeStatus: 'heldForReview' });
    const gone = await w.queuedAction(c, 'hide', { fakeStatus: 'deleted' });
    const edited = await w.queuedAction(c, 'hide');
    w.advance(1000);
    w.fake.updateComment(edited.externalId, { textOriginal: 'edited by the author' });
    const from = w.fake.calls.length;

    expect(await dispatch(c.scope)).toEqual({ batchesSent: 0, unitsSpent: 1, stoppedBy: null });
    expect(w.callsSince(from, WRITE)).toEqual([]);
    expect(await w.action(held.actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'already_moderated',
      platform_state: 'hidden',
    });
    expect(await w.action(gone.actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'comment_gone',
      platform_state: 'deleted',
    });
    expect(await w.action(edited.actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'comment_edited',
      platform_state: 'visible',
    });
    expect(w.producer.enqueue).toHaveBeenCalledTimes(1);
    expect(w.producer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: INGEST_JOB.type,
        platform: 'youtube',
        payload: expect.objectContaining({ commentExternalId: edited.externalId }),
      }),
    );
    expect(await w.queue(c.scope)).toEqual([]);
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['confirmed']);
  });

  it('de-duplicates comment ids before probing and writing', async () => {
    const c = await w.connect('dedupe');
    const a = await w.queuedAction(c, 'hide');
    // A second pending hold on the same comment (the planner would supersede it).
    const requestedAt = w.now();
    const b = {
      actionId: (
        await w.pool.query<{ id: string }>(
          `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                          actor_type, actor_user_id, request_key, created_at)
           VALUES ($1, $2, $3, $4, 'hide', 'user', $5, $6, $7) RETURNING id`,
          [
            c.scope.organizationId,
            c.scope.brandId,
            c.scope.connectionId,
            a.commentId,
            c.userId,
            `rk-${randomUUID()}`,
            requestedAt,
          ],
        )
      ).rows[0]!.id,
    };
    await w.backlog.enqueue(c.scope, {
      actionId: b.actionId,
      commentId: a.commentId,
      kind: 'hide',
      requestedAt,
    });
    const from = w.fake.calls.length;
    const plan: CyclePlan = {
      batches: [
        {
          moderationStatus: 'heldForReview',
          banAuthor: false,
          action: 'hide',
          items: [a, b].map((x) => ({
            actionId: x.actionId,
            commentExternalId: a.externalId,
            sourceExternalId: c.videoId,
            folded: false,
          })),
        },
      ],
      settleNow: [],
      deferred: [],
      plannedUnits: 51,
    };
    await dispatch(c.scope, undefined, plan);
    expect(w.callsSince(from, WRITE).map((x) => x.query.id)).toEqual([a.externalId]);
    expect(w.callsSince(from, PROBE).map((x) => x.query.id)).toEqual([a.externalId]);
    expect((await w.action(a.actionId)).status).toBe('applied');
    expect((await w.action(b.actionId)).status).toBe('applied');
  });

  it('restart does not apply or count twice', async () => {
    const c = await w.connect('restart');
    const h1 = await w.queuedAction(c, 'hide');
    const h2 = await w.queuedAction(c, 'hide');
    const r = await real(c.scope);
    const crashing: Client = {
      probeComments: (refs) => r.probeComments(refs),
      actBatch: async (req) => {
        expect((await r.actBatch(req)).status).toBe('applied');
        throw new Error('simulated crash');
      },
    };
    const from = w.fake.calls.length;
    await expect(dispatch(c.scope, crashing)).rejects.toThrow('simulated crash');
    expect(w.callsSince(from, WRITE)).toHaveLength(1);
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['sent']);
    expect((await w.queue(c.scope)).map((q) => q.state)).toEqual(['in_flight', 'in_flight']);

    // Within the lease the batch may still be in progress elsewhere: left alone.
    const fresh = await deps(c.scope);
    await recoverInFlight(fresh, c.scope);
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['sent']);
    expect(w.callsSince(from, PROBE)).toHaveLength(1);

    w.advance(CYCLE_LEASE_MS + 1);
    await recoverInFlight(await deps(c.scope), c.scope);
    expect(w.callsSince(from, WRITE)).toHaveLength(1);
    expect(w.callsSince(from, PROBE)).toHaveLength(2);
    for (const a of [h1, h2])
      expect(await w.action(a.actionId)).toEqual({
        status: 'applied',
        outcome_code: 'confirmed_after_restart',
        undo_kind: 'unhide',
        platform_state: 'hidden',
      });
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['confirmed']);
    expect(await w.queue(c.scope)).toEqual([]);
    expect(await writeUnits(c.scope)).toBe(50);

    // Nothing left to recover or send.
    await recoverInFlight(await deps(c.scope), c.scope);
    expect(await dispatch(c.scope)).toEqual({ batchesSent: 0, unitsSpent: 0, stoppedBy: null });
    expect(w.callsSince(from, WRITE)).toHaveLength(1);
    expect(await writeUnits(c.scope)).toBe(50);
  });

  it('a sent ban batch recovers as ban_unconfirmed; one not yet applied is requeued', async () => {
    const c = await w.connect('restart-ban');
    const ban = await w.queuedAction(c, 'ban_author');
    const other = await w.queuedAction(c, 'ban_author');
    const r = await real(c.scope);
    const crashing: Client = {
      probeComments: (refs) => r.probeComments(refs),
      actBatch: async () => {
        // The process dies after sending; only one of the two took effect.
        w.fake.updateComment(ban.externalId, { status: 'rejected' });
        throw new Error('simulated crash');
      },
    };
    await expect(dispatch(c.scope, crashing)).rejects.toThrow('simulated crash');
    w.advance(CYCLE_LEASE_MS + 1);
    await recoverInFlight(await deps(c.scope), c.scope);
    expect(await w.action(ban.actionId)).toMatchObject({
      status: 'applied',
      outcome_code: 'ban_unconfirmed',
      platform_state: 'deleted',
    });
    expect((await w.action(other.actionId)).status).toBe('pending');
    expect(await w.queue(c.scope)).toEqual([
      { action_id: other.actionId, state: 'queued', batch_id: null },
    ]);
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['confirmed']);
  });

  it('planned batch from a crash is requeued and sent once later', async () => {
    const c = await w.connect('planned');
    const a = await w.queuedAction(c, 'hide');
    const r = await real(c.scope);
    const crashing: Client = {
      probeComments: async () => {
        throw new Error('simulated crash');
      },
      actBatch: (req) => r.actBatch(req),
    };
    const from = w.fake.calls.length;
    await expect(dispatch(c.scope, crashing)).rejects.toThrow('simulated crash');
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['planned']);

    w.advance(CYCLE_LEASE_MS + 1);
    await recoverInFlight(await deps(c.scope), c.scope);
    expect(w.callsSince(from)).toEqual([]);
    expect(await w.queue(c.scope)).toEqual([
      { action_id: a.actionId, state: 'queued', batch_id: null },
    ]);
    expect((await w.action(a.actionId)).status).toBe('pending');

    expect(await dispatch(c.scope)).toMatchObject({ batchesSent: 1, stoppedBy: null });
    expect(w.callsSince(from, WRITE)).toHaveLength(1);
    expect(await w.action(a.actionId)).toMatchObject({ status: 'applied', outcome_code: null });
    expect((await w.batches(c.scope)).map((b) => [b.state, b.outcome_code])).toEqual([
      ['failed', 'restart_requeued'],
      ['confirmed', null],
    ]);
  });

  it('batch with a vanished comment re-probes and retries survivors once', async () => {
    const c = await w.connect('vanished');
    const keep = await w.queuedAction(c, 'hide');
    const vanish = await w.queuedAction(c, 'hide');
    const r = await real(c.scope);
    let first = true;
    const vanishing: Client = {
      probeComments: async (refs) => {
        const p = await r.probeComments(refs);
        if (first) w.fake.updateComment(vanish.externalId, { status: 'deleted' });
        first = false;
        return p;
      },
      actBatch: (req) => r.actBatch(req),
    };
    const from = w.fake.calls.length;
    expect(await dispatch(c.scope, vanishing)).toEqual({
      batchesSent: 1,
      unitsSpent: 102,
      stoppedBy: null,
    });
    expect(w.callsSince(from, WRITE).map((x) => x.query.id)).toEqual([
      `${keep.externalId},${vanish.externalId}`,
      keep.externalId,
    ]);
    expect(w.callsSince(from, PROBE)).toHaveLength(2);
    expect(await w.action(keep.actionId)).toMatchObject({
      status: 'applied',
      outcome_code: null,
    });
    expect(await w.action(vanish.actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'comment_gone',
      platform_state: 'deleted',
    });
    expect((await auditOf(c.scope, keep.actionId)).quota).toMatchObject({
      units: 102,
      batchSize: 1,
    });
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['confirmed']);
  });

  it('a batch still not found after the retry is requeued and marked failed', async () => {
    const c = await w.connect('not-found');
    const a = await w.queuedAction(c, 'hide');
    w.fake.failOn(WRITE, 'commentNotFound', 404);
    const from = w.fake.calls.length;
    expect(await dispatch(c.scope)).toMatchObject({ batchesSent: 1, stoppedBy: null });
    expect(w.callsSince(from, WRITE)).toHaveLength(2);
    expect((await w.action(a.actionId)).status).toBe('pending');
    expect(await w.queue(c.scope)).toEqual([
      { action_id: a.actionId, state: 'queued', batch_id: null },
    ]);
    expect((await w.batches(c.scope)).map((b) => [b.state, b.outcome_code])).toEqual([
      ['failed', 'not_found'],
    ]);
  });

  it('quotaExceeded mid-cycle requeues everything not yet sent and stops', async () => {
    const c = await w.connect('quota');
    const ban = await w.queuedAction(c, 'ban_author');
    const reject = await w.queuedAction(c, 'delete');
    const hold = await w.queuedAction(c, 'hide');
    // The first batch (51) and the second probe fit; the second write does not.
    w.fake.exhaustQuotaAt(w.fake.unitsUsed + 60);
    const plan = await w.plan(c.scope);
    expect(plan.batches).toHaveLength(3);
    const from = w.fake.calls.length;

    expect(await dispatch(c.scope, undefined, plan)).toEqual({
      batchesSent: 2,
      unitsSpent: 102,
      stoppedBy: 'quota_exceeded',
    });
    expect(w.callsSince(from, WRITE)).toHaveLength(2);
    expect((await w.action(ban.actionId)).status).toBe('applied');
    expect((await w.action(reject.actionId)).status).toBe('pending');
    expect((await w.action(hold.actionId)).status).toBe('pending');
    expect(await w.queue(c.scope)).toEqual([
      { action_id: reject.actionId, state: 'queued', batch_id: null },
      { action_id: hold.actionId, state: 'queued', batch_id: null },
    ]);
    expect((await w.batches(c.scope)).map((b) => [b.state, b.outcome_code])).toEqual([
      ['confirmed', null],
      ['failed', 'quota_exceeded'],
    ]);
    expect((await w.ledger.usage(c.scope)).paused).toBe(true);
  });

  it('a write the budget refuses requeues the batch and stops with budget', async () => {
    const c = await w.connect('budget');
    const a = await w.queuedAction(c, 'hide');
    const plan = await w.plan(c.scope);
    // Budget 100 is all read reserve: the probe fits, the write does not.
    await w.settings.update(c.scope, { dailyBudgetUnits: 100 }, c.userId);
    const from = w.fake.calls.length;
    expect(await dispatch(c.scope, undefined, plan)).toEqual({
      batchesSent: 0,
      unitsSpent: 1,
      stoppedBy: 'budget',
    });
    expect(w.callsSince(from, WRITE)).toEqual([]);
    expect(await w.queue(c.scope)).toEqual([
      { action_id: a.actionId, state: 'queued', batch_id: null },
    ]);
    expect((await w.batches(c.scope)).map((b) => [b.state, b.outcome_code])).toEqual([
      ['failed', 'quota_budget_exhausted'],
    ]);
  });

  it('a transient write failure requeues and rethrows for the job to retry', async () => {
    const c = await w.connect('transient');
    const a = await w.queuedAction(c, 'hide');
    w.fake.failOn(WRITE, 'backendError', 503);
    const err = await dispatch(c.scope).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).kind).toBe('transient');
    expect((await w.action(a.actionId)).status).toBe('pending');
    expect(await w.queue(c.scope)).toEqual([
      { action_id: a.actionId, state: 'queued', batch_id: null },
    ]);
    expect((await w.batches(c.scope)).map((b) => b.state)).toEqual(['failed']);
  });

  it('hold_not_allowed settles failed so review fallback flags it', async () => {
    const c = await w.connect('hold-not-allowed');
    const a = await w.queuedAction(c, 'hide');
    w.fake.failOn(WRITE, 'operationNotSupported', 400);
    expect(await dispatch(c.scope)).toMatchObject({ batchesSent: 1, stoppedBy: null });
    expect(await w.action(a.actionId)).toMatchObject({
      status: 'failed',
      outcome_code: 'hold_not_allowed',
      platform_state: 'visible',
    });
    expect(w.outcomes).toContainEqual({
      actionId: a.actionId,
      status: 'failed',
      code: 'hold_not_allowed',
    });
    expect(await w.queue(c.scope)).toEqual([]);
    expect((await w.batches(c.scope)).map((b) => [b.state, b.outcome_code])).toEqual([
      ['failed', 'hold_not_allowed'],
    ]);
  });

  it('settles settleNow items at zero cost and logs a protected ban', async () => {
    const c = await w.connect('settle-now');
    const moderator = author();
    await w.settings.update(c.scope, { protectedAuthorIds: [moderator] }, c.userId);
    const ban = await w.queuedAction(c, 'ban_author', { author: moderator });
    const unhide = await w.queuedAction(c, 'unhide');
    const from = w.fake.calls.length;
    expect(await dispatch(c.scope)).toEqual({ batchesSent: 0, unitsSpent: 0, stoppedBy: null });
    expect(w.callsSince(from)).toEqual([]);
    expect(await w.action(ban.actionId)).toMatchObject({
      status: 'not_eligible',
      outcome_code: 'author_protected',
    });
    expect(await w.action(unhide.actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'already_published',
    });
    expect(await w.queue(c.scope)).toEqual([]);
    expect(w.lines.find((l) => l.msg === 'youtube.ban_protected_author')).toMatchObject({
      actionId: ban.actionId,
    });
  });

  it('prunes confirmed and failed batches older than two Pacific days', async () => {
    const c = await w.connect('prune');
    const other = await w.connect('prune-other');
    const a = await w.queuedAction(c, 'hide');
    const insert = (s: ConnectionScope, day: string, state: string) =>
      w.pool.query(
        `INSERT INTO youtube_write_batch (organization_id, brand_id, connection_id, pacific_day,
           moderation_status, ban_author, comment_external_ids, action_ids, state)
         VALUES ($1, $2, $3, $4::date, 'heldForReview', false, $5, $6::uuid[], $7)`,
        [s.organizationId, s.brandId, s.connectionId, day, [a.externalId], [a.actionId], state],
      );
    await insert(c.scope, '2026-10-21', 'confirmed');
    await insert(c.scope, '2026-10-21', 'failed');
    await insert(c.scope, '2026-10-21', 'sent');
    await insert(c.scope, '2026-10-22', 'confirmed');
    await insert(other.scope, '2026-10-21', 'confirmed');
    await dispatch(c.scope, undefined, {
      batches: [],
      settleNow: [],
      deferred: [],
      plannedUnits: 0,
    });
    expect((await w.batches(c.scope)).map((b) => [b.pacific_day, b.state]).sort()).toEqual([
      ['2026-10-21', 'sent'],
      ['2026-10-22', 'confirmed'],
    ]);
    expect(await w.batches(other.scope)).toHaveLength(1);
  });
});

describe('dispatchPlan (dry run)', () => {
  it('dry run calls no write endpoint and logs would-cost', async () => {
    const c = await w.connect('dry-run');
    const ban = await w.queuedAction(c, 'ban_author');
    const hold = await w.queuedAction(c, 'hide');
    const plan = await w.plan(c.scope, { simulated: true });
    expect(plan.batches).toHaveLength(2);
    const from = w.fake.calls.length;
    const used = w.fake.unitsUsed;

    expect(
      await dispatchPlan(await deps(c.scope), c.scope, plan, { dryRun: true, pacificDay: DAY }),
    ).toEqual({ batchesSent: 0, unitsSpent: 0, stoppedBy: null });
    expect(w.callsSince(from)).toEqual([]);
    expect(w.fake.unitsUsed).toBe(used);
    for (const a of [ban, hold])
      expect(await w.action(a.actionId)).toMatchObject({
        status: 'noop',
        outcome_code: 'dry_run',
        platform_state: 'visible',
      });
    expect((await auditOf(c.scope, ban.actionId)).quota).toEqual({
      units: 51,
      batchSize: 1,
      remainingUnits: 2000 - 51,
      pacificDay: DAY,
      simulated: true,
    });
    expect((await auditOf(c.scope, hold.actionId)).quota).toMatchObject({
      remainingUnits: 2000 - 102,
      simulated: true,
    });
    expect((await w.ledger.usage(c.scope)).spentUnits).toBe(0);
    expect((await w.ledger.usage(c.scope, { simulated: true })).spentUnits).toBe(102);
    expect(await w.queue(c.scope)).toEqual([]);
    expect(await w.batches(c.scope)).toEqual([]);
    expect(w.lines.filter((l) => l.msg === 'youtube.dry_run_batch')).toEqual([
      expect.objectContaining({ wouldCostUnits: 51, batchSize: 1 }),
      expect.objectContaining({ wouldCostUnits: 51, batchSize: 1 }),
    ]);
  });

  it('a dry run past the simulated allowance stops with budget and leaves the rest queued', async () => {
    const c = await w.connect('dry-run-budget');
    const a = await w.queuedAction(c, 'hide');
    const plan = await w.plan(c.scope, { simulated: true });
    await w.settings.update(c.scope, { dailyBudgetUnits: 100 }, c.userId);
    expect(
      await dispatchPlan(await deps(c.scope), c.scope, plan, { dryRun: true, pacificDay: DAY }),
    ).toEqual({ batchesSent: 0, unitsSpent: 0, stoppedBy: 'budget' });
    expect((await w.action(a.actionId)).status).toBe('pending');
    expect(await w.queue(c.scope)).toEqual([
      { action_id: a.actionId, state: 'queued', batch_id: null },
    ]);
  });
});
