// The cycle job end to end over the real connector runtime, the Pg stores and FakeYouTube.
// The fake's one channel is shared by every connection here, so assertions look at call
// deltas and at each test's own tenant.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { JobError } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { revokeConnection } from '../disconnect.js';
import { pacificDayKey } from './quota-day.js';
import { NOW_MS, youtubeWorld, type YouTubeWorld } from './test-world.js';

const WRITE = 'comments.setModerationStatus';
const MIDNIGHT_MS = Date.parse('2026-10-24T07:00:00Z') + 86_400_000;

let w: YouTubeWorld;
beforeAll(async () => {
  w = await youtubeWorld('cycle');
});
afterAll(() => w.close());
beforeEach(async () => {
  w.reset();
  await w.clearPause();
});

const budget = (c: { scope: ConnectionScope; userId: string }, units: number) =>
  w.settings.update(c.scope, { dailyBudgetUnits: units }, c.userId);
const cycleState = async (scope: ConnectionScope) =>
  (
    await w.pool.query<{
      next_read_at: Date;
      next_dispatch_at: Date | null;
      lease_token: string | null;
    }>(
      `SELECT next_read_at, next_dispatch_at, lease_token FROM youtube_connection_state
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    )
  ).rows[0]!;
const writeUnits = async (scope: ConnectionScope, at = NOW_MS) =>
  (await w.ledger.dailyTotals(scope, pacificDayKey(at))).find((t) => t.method === WRITE)?.units ??
  0;
const emailsTo = async (userId: string) => {
  const { rows } = await w.pool.query<{ email: string }>(
    'SELECT email FROM app_user WHERE id = $1',
    [userId],
  );
  return w.mailer.sent.filter((m) => m.to === rows[0]!.email);
};
const quotaEmails = async (userId: string) =>
  (await emailsTo(userId)).filter((m) => m.subject.includes('quota'));
const writes = (from: number) =>
  w.callsSince(from, WRITE).map((c) => [c.query['moderationStatus'], c.query['banAuthor']]);

describe('youtubeCycleJob', () => {
  it('refuses a payload for another connection and a connection outside the scope', async () => {
    const c = await w.connect('scope');
    const other = await w.connect('scope-other');
    const from = w.fake.calls.length;

    await expect(
      w.cycleJob.handle(w.jobCtx(c.scope), { connectionId: other.scope.connectionId }),
    ).rejects.toMatchObject({ code: 'scope_mismatch' });
    await expect(
      w.runCycle({ ...c.scope, connectionId: other.scope.connectionId }),
    ).rejects.toMatchObject({ code: 'connection_not_found' });
    await expect(
      w.runCycle({ ...c.scope, connectionId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toBeInstanceOf(JobError);

    expect(w.callsSince(from)).toHaveLength(0);
  });

  it('concurrent cycles claim once', async () => {
    const c = await w.connect('concurrent');
    await w.queuedAction(c, 'hide');
    const from = w.fake.calls.length;

    const results = await Promise.all([w.runCycle(c.scope), w.runCycle(c.scope)]);

    expect(results.map((r) => r['status'])).toContain('done');
    expect(w.callsSince(from, WRITE)).toHaveLength(1);
    expect(await writeUnits(c.scope)).toBe(50);
    expect((await cycleState(c.scope)).lease_token).toBeNull();
  });

  it('does nothing while another cycle holds the lease', async () => {
    const c = await w.connect('leased');
    await w.queuedAction(c, 'hide');
    const claim = await w.state.claim(c.scope, w.now());
    const from = w.fake.calls.length;

    expect(await w.runCycle(c.scope)).toEqual({ status: 'leased' });

    expect(w.callsSince(from)).toHaveLength(0);
    await w.state.release(c.scope, claim!.leaseToken, w.now(), {});
    expect(await w.runCycle(c.scope)).toEqual({ status: 'done' });
    expect(w.callsSince(from, WRITE)).toHaveLength(1);
  });

  it('holds, rejects and bans on YouTube, most severe first, and schedules the next read', async () => {
    const c = await w.connect('order');
    const hold = await w.queuedAction(c, 'hide');
    const reject = await w.queuedAction(c, 'delete');
    const ban = await w.queuedAction(c, 'ban_author');
    const from = w.fake.calls.length;

    await w.runCycle(c.scope);

    expect(writes(from)).toEqual([
      ['rejected', 'true'],
      ['rejected', undefined],
      ['heldForReview', undefined],
    ]);
    expect((await w.action(ban.actionId)).status).toBe('applied');
    expect((await w.action(reject.actionId)).status).toBe('applied');
    expect((await w.action(hold.actionId)).status).toBe('applied');
    expect(w.fake.isBanned(ban.author)).toBe(true);
    const s = await cycleState(c.scope);
    expect(s.next_read_at.getTime()).toBeGreaterThanOrEqual(NOW_MS + 300_000);
    expect(s.next_dispatch_at).toBeNull();
  });

  it('budget 0 makes no calls and waits for the reset', async () => {
    const c = await w.connect('zero');
    await budget(c, 0);
    const queued = await w.queuedAction(c, 'hide');
    const from = w.fake.calls.length;

    await w.runCycle(c.scope);

    expect(w.callsSince(from)).toHaveLength(0);
    expect((await w.action(queued.actionId)).status).toBe('pending');
    const s = await cycleState(c.scope);
    expect(s.next_read_at.getTime()).toBe(MIDNIGHT_MS);
    expect(s.next_dispatch_at).toBeNull();
  });

  it('a budget lowered below today spend makes no calls and does not fail', async () => {
    const c = await w.connect('lowered');
    await w.runCycle(c.scope);
    await budget(c, 1);
    const from = w.fake.calls.length;
    w.advance(600_000);

    await expect(w.runCycle(c.scope)).resolves.toEqual({ status: 'done' });

    expect(w.callsSince(from)).toHaveLength(0);
  });

  it('low budget polls and leaves actions waiting', async () => {
    const c = await w.connect('low');
    await budget(c, 120);
    const queued = await w.queuedAction(c, 'hide');
    const from = w.fake.calls.length;

    await w.runCycle(c.scope);

    expect(w.callsSince(from, 'commentThreads.list').length).toBeGreaterThan(0);
    expect(w.callsSince(from, WRITE)).toHaveLength(0);
    expect((await w.action(queued.actionId)).status).toBe('pending');
    expect(await w.backlog.counts(c.scope)).toMatchObject({ hold: 1 });
    const s = await cycleState(c.scope);
    expect(s.next_read_at.getTime() - NOW_MS).toBeGreaterThan(300_000);
    expect(s.next_dispatch_at).toBeNull();
  });

  it('a dry-run connection settles its actions without a write', async () => {
    const c = await w.connect('dry');
    await w.settings.update(c.scope, { dryRun: true }, c.userId);
    const queued = await w.queuedAction(c, 'hide');
    const from = w.fake.calls.length;

    await w.runCycle(c.scope);

    expect(w.callsSince(from, WRITE)).toHaveLength(0);
    expect(await w.action(queued.actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'dry_run',
    });
  });

  it('project-wide pause notifies each connection once', async () => {
    const a = await w.connect('pause-a');
    const b = await w.connect('pause-b');
    await w.queuedAction(a, 'hide');
    await w.queuedAction(b, 'hide');
    w.fake.exhaustQuotaAt(w.fake.unitsUsed);

    await w.runCycle(a.scope);
    const from = w.fake.calls.length;
    for (let i = 0; i < 3; i++) {
      w.advance(60_000);
      await w.runCycle(a.scope);
      await w.runCycle(b.scope);
    }

    expect(w.callsSince(from)).toHaveLength(0);
    expect(await quotaEmails(a.userId)).toHaveLength(1);
    expect(await quotaEmails(b.userId)).toHaveLength(1);
    expect((await cycleState(b.scope)).next_read_at.getTime()).toBe(MIDNIGHT_MS);
  });

  it('resumes after Pacific midnight and sends the carried-over backlog most severe first', async () => {
    const c = await w.connect('resume');
    w.advance(Date.parse('2026-11-01T06:59:00Z') - w.now().getTime());
    const hold = await w.queuedAction(c, 'hide');
    const reject = await w.queuedAction(c, 'delete');
    const ban = await w.queuedAction(c, 'ban_author');
    w.fake.exhaustQuotaAt(w.fake.unitsUsed);
    await w.runCycle(c.scope);
    expect((await w.action(hold.actionId)).status).toBe('pending');
    const paused = w.fake.calls.length;
    w.advance(30_000);
    await w.runCycle(c.scope);
    expect(w.callsSince(paused)).toHaveLength(0);

    w.advance(Date.parse('2026-11-01T07:00:01Z') - w.now().getTime());
    w.fake.exhaustQuotaAt(10_000_000);
    await w.runCycle(c.scope);

    expect(writes(paused)).toEqual([
      ['rejected', 'true'],
      ['rejected', undefined],
      ['heldForReview', undefined],
    ]);
    for (const a of [hold, reject, ban])
      expect((await w.action(a.actionId)).status).toBe('applied');
    expect(await writeUnits(c.scope, Date.parse('2026-11-01T07:00:01Z'))).toBe(150);
    expect(await quotaEmails(c.userId)).toHaveLength(1);
  });

  it('an expired token pauses the connector and keeps the backlog, which drains after reconnecting', async () => {
    const c = await w.connect('expired');
    const queued = await w.queuedAction(c, 'hide');
    await w.creds.put(
      c.scope,
      'access_token',
      new Secret('ya29.unknown'),
      new Date(NOW_MS + 3_600_000),
    );
    await w.creds.put(c.scope, 'refresh_token', new Secret('1//revoked'), null);

    await expect(w.runCycle(c.scope)).rejects.toMatchObject({ kind: 'auth_expired' });

    const status = await w.pool.query<{ status: string }>(
      'SELECT status FROM connection WHERE id = $1',
      [c.scope.connectionId],
    );
    expect(status.rows[0]!.status).toBe('reconnect_required');
    expect(
      (await emailsTo(c.userId)).filter((m) => m.subject.toLowerCase().includes('reconnect')),
    ).toHaveLength(1);
    expect(await w.backlog.counts(c.scope)).toMatchObject({ hold: 1 });
    expect((await w.action(queued.actionId)).status).toBe('pending');
    expect((await cycleState(c.scope)).lease_token).toBeNull();
    expect(await w.runCycle(c.scope)).toEqual({ status: 'inactive' });

    await w.pool.query(
      "UPDATE connection SET status = 'active', status_reason = NULL WHERE id = $1",
      [c.scope.connectionId],
    );
    await w.giveTokens(c.scope);
    await w.runCycle(c.scope);

    expect((await w.action(queued.actionId)).status).toBe('applied');
    expect(await w.backlog.counts(c.scope)).toEqual({ ban: 0, reject: 0, hold: 0, publish: 0 });
  });

  it('disconnecting abandons the backlog as connection_disconnected', async () => {
    const c = await w.connect('disconnect');
    const queued = await w.queuedAction(c, 'hide');
    const other = await w.connect('disconnect-other');
    const kept = await w.queuedAction(other, 'hide');

    await revokeConnection(
      {
        pool: w.pool,
        directory: w.directory,
        backfill: { cancel: async () => {} },
        backlog: w.backlog,
        log: w.log,
      },
      c.scope,
      c.userId,
    );

    expect(await w.action(queued.actionId)).toMatchObject({
      status: 'failed',
      outcome_code: 'connection_disconnected',
    });
    expect(await w.backlog.counts(c.scope)).toEqual({ ban: 0, reject: 0, hold: 0, publish: 0 });
    expect(await w.backlog.counts(other.scope)).toMatchObject({ hold: 1 });
    expect((await w.action(kept.actionId)).status).toBe('pending');
    const from = w.fake.calls.length;
    expect(await w.runCycle(c.scope)).toEqual({ status: 'inactive' });
    expect(w.callsSince(from)).toHaveLength(0);
  });
});
