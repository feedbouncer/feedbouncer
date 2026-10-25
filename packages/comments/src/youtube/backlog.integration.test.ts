import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import type { Clock, PlatformState } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { createLogger } from '@feedbouncer/service-runtime';
import type { ActionOutcomeObserver } from '../hooks.js';
import { PgYouTubeBacklog } from './backlog.js';
import type { QueuedKind } from './planner.js';

// 2026-10-24 05:00 Pacific (PDT).
const START_MS = Date.parse('2026-10-24T12:00:00Z');
const log = createLogger('comments-youtube-backlog-test', 'error', () => {});

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
const clock: Clock = { now: () => START_MS };
let outcomes: { actionId: string; status: string; code: string | null; platform: string }[] = [];
const observer: ActionOutcomeObserver = {
  onActionOutcome: async (e) =>
    void outcomes.push({
      actionId: e.actionId,
      status: e.status,
      code: e.code,
      platform: e.platform,
    }),
};

const backlog = (cap = 5000) => new PgYouTubeBacklog({ pool, clock, cap, log, outcomes: observer });

interface World extends ConnectionScope {
  userId: string;
  sourceId: string;
  authorId: string;
}

const channel = () => `UC${randomUUID().replaceAll('-', '').slice(0, 22)}`;
const commentExt = () => `Ugx${randomUUID().replaceAll('-', '')}`;

const youtubeWorld = async (label: string): Promise<World> => {
  const t = await seedTenant(db.c, `yt-backlog-${label}`);
  const one = async (sql: string, v: unknown[]) =>
    (await db.c.query<{ id: string }>(sql, v)).rows[0]!.id;
  const connectionId = await one(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, 'youtube', $3) RETURNING id`,
    [t.organizationId, t.brandId, channel()],
  );
  const sourceId = await one(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'video', 'dQw4w9WgXcQ') RETURNING id`,
    [t.organizationId, t.brandId, connectionId],
  );
  const authorId = await one(
    `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
     VALUES ($1, $2, $3, $4, 'Viewer') RETURNING id`,
    [t.organizationId, t.brandId, connectionId, channel()],
  );
  return {
    organizationId: t.organizationId,
    brandId: t.brandId,
    connectionId,
    userId: t.userId,
    sourceId,
    authorId,
  };
};

let seq = 0;
/** A stored comment with a pending action on it, created `seq` seconds after START. */
const pendingAction = async (
  w: World,
  kind: QueuedKind,
  o: { state?: PlatformState; parentExternalId?: string } = {},
) => {
  seq += 1;
  const ext = commentExt();
  const commentId = (
    await db.c.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id,
                            author_id, parent_external_id, body, platform_state, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'body', $8, $9) RETURNING id`,
      [
        w.organizationId,
        w.brandId,
        w.connectionId,
        w.sourceId,
        ext,
        w.authorId,
        o.parentExternalId ?? null,
        o.state ?? 'visible',
        new Date(START_MS - 3_600_000),
      ],
    )
  ).rows[0]!.id;
  const requestedAt = new Date(START_MS + seq * 1000);
  const actionId = (
    await db.c.query<{ id: string }>(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, actor_user_id, request_key, created_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8) RETURNING id`,
      [
        w.organizationId,
        w.brandId,
        w.connectionId,
        commentId,
        kind,
        w.userId,
        `rk-${randomUUID()}`,
        requestedAt,
      ],
    )
  ).rows[0]!.id;
  return { actionId, commentId, kind, requestedAt, externalId: ext };
};

const queueRows = async (s: ConnectionScope) =>
  (
    await pool.query<{ action_id: string; tier: number; state: string }>(
      `SELECT action_id, tier, state FROM youtube_action_queue
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
        ORDER BY tier, requested_at, action_id`,
      [s.organizationId, s.brandId, s.connectionId],
    )
  ).rows;

const actionStatus = async (actionId: string) =>
  (
    await pool.query<{ status: string; outcome_code: string | null }>(
      'SELECT status, outcome_code FROM moderation_action WHERE id = $1',
      [actionId],
    )
  ).rows[0]!;

const audits = async (s: ConnectionScope) =>
  (
    await pool.query<{ details: { actionId: string; status: string; outcomeCode: string } }>(
      `SELECT details FROM audit_event
        WHERE organization_id = $1 AND brand_id = $2 AND action = 'comment.moderated'
        ORDER BY sequence`,
      [s.organizationId, s.brandId],
    )
  ).rows.map((r) => r.details);

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'yt-backlog', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await db.close();
});
beforeEach(() => {
  outcomes = [];
});

describe('PgYouTubeBacklog', () => {
  it('enqueue is idempotent per action', async () => {
    const w = await youtubeWorld('idempotent');
    const a = await pendingAction(w, 'hide');
    const b = backlog();
    await b.enqueue(w, a);
    await b.enqueue(w, a);
    await backlog().enqueue(w, a);
    expect(await queueRows(w)).toEqual([{ action_id: a.actionId, tier: 2, state: 'queued' }]);
    // A replay while the action is in flight leaves it in flight.
    await withTransaction(pool, (tx) => b.markInFlight(tx, w, randomUUID(), [a.actionId]));
    await b.enqueue(w, a);
    expect((await queueRows(w)).map((r) => r.state)).toEqual(['in_flight']);
    expect(await b.counts(w)).toEqual({ ban: 0, reject: 0, hold: 1, publish: 0 });
  });

  it('stores the tier of each kind', async () => {
    const w = await youtubeWorld('tiers');
    const b = backlog();
    const kinds: QueuedKind[] = ['unhide', 'hide', 'delete', 'ban_author'];
    for (const k of kinds) await b.enqueue(w, await pendingAction(w, k));
    expect((await queueRows(w)).map((r) => r.tier)).toEqual([0, 1, 2, 3]);
    expect(await b.counts(w)).toEqual({ ban: 1, reject: 1, hold: 1, publish: 1 });
  });

  it('refuses an action outside the scope', async () => {
    const w = await youtubeWorld('scope-a');
    const other = await youtubeWorld('scope-b');
    const a = await pendingAction(w, 'hide');
    await expect(backlog().enqueue({ ...other, connectionId: w.connectionId }, a)).rejects.toThrow(
      'youtube_backlog_action_not_found',
    );
    await expect(backlog().enqueue(other, a)).rejects.toThrow('youtube_backlog_action_not_found');
    expect(await queueRows(w)).toEqual([]);
  });

  it('overflow evicts lowest tier newest first and records the count', async () => {
    const w = await youtubeWorld('overflow');
    const b = backlog(3);
    const ban = await pendingAction(w, 'ban_author');
    const holds = [];
    for (let i = 0; i < 4; i++) holds.push(await pendingAction(w, 'hide'));
    await b.enqueue(w, ban);
    for (const h of holds) await b.enqueue(w, h);
    const [hold1, hold2, hold3, hold4] = holds as [
      (typeof holds)[0],
      (typeof holds)[0],
      (typeof holds)[0],
      (typeof holds)[0],
    ];

    expect((await queueRows(w)).map((r) => r.action_id)).toEqual([
      ban.actionId,
      hold1.actionId,
      hold2.actionId,
    ]);
    const failed = await pool.query<{ id: string; status: string; outcome_code: string }>(
      `SELECT id, status, outcome_code FROM moderation_action
        WHERE connection_id = $1 AND status <> 'pending' ORDER BY created_at DESC`,
      [w.connectionId],
    );
    expect(failed.rows).toEqual([
      { id: hold4.actionId, status: 'failed', outcome_code: 'backlog_overflow' },
      { id: hold3.actionId, status: 'failed', outcome_code: 'backlog_overflow' },
    ]);
    expect(outcomes.map((o) => [o.actionId, o.status, o.code, o.platform]).sort()).toEqual(
      [
        [hold3.actionId, 'failed', 'backlog_overflow', 'youtube'],
        [hold4.actionId, 'failed', 'backlog_overflow', 'youtube'],
      ].sort(),
    );
    expect((await audits(w)).map((d) => [d.actionId, d.status, d.outcomeCode]).sort()).toEqual(
      [
        [hold3.actionId, 'failed', 'backlog_overflow'],
        [hold4.actionId, 'failed', 'backlog_overflow'],
      ].sort(),
    );
    const notice = await pool.query(
      `SELECT kind, to_char(pacific_day, 'YYYY-MM-DD') AS day, count FROM youtube_notice
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [w.organizationId, w.brandId, w.connectionId],
    );
    expect(notice.rows).toEqual([{ kind: 'backlog_overflow', day: '2026-10-24', count: 2 }]);
  });

  it('a more severe action evicts a queued lower tier one', async () => {
    const w = await youtubeWorld('overflow-tier');
    const b = backlog(1);
    const hold = await pendingAction(w, 'hide');
    const ban = await pendingAction(w, 'ban_author');
    await b.enqueue(w, hold);
    await b.enqueue(w, ban);
    expect((await queueRows(w)).map((r) => r.action_id)).toEqual([ban.actionId]);
    expect(await actionStatus(hold.actionId)).toEqual({
      status: 'failed',
      outcome_code: 'backlog_overflow',
    });
  });

  it('eviction skips a row a concurrent cycle holds locked', async () => {
    const w = await youtubeWorld('overflow-locked');
    const b = backlog(1);
    const hold = await pendingAction(w, 'hide');
    const ban = await pendingAction(w, 'ban_author');
    await b.enqueue(w, hold);
    // A cycle is claiming the hold (markInFlight not yet committed).
    const cycle = await pool.connect();
    try {
      await cycle.query('BEGIN');
      await cycle.query(`SELECT 1 FROM youtube_action_queue WHERE action_id = $1 FOR UPDATE`, [
        hold.actionId,
      ]);
      await b.enqueue(w, ban);
      expect(await actionStatus(hold.actionId)).toEqual({ status: 'pending', outcome_code: null });
      expect(outcomes).toEqual([]);
      await b.markInFlight(cycle, w, randomUUID(), [hold.actionId]);
      await cycle.query('COMMIT');
    } finally {
      cycle.release();
    }
    // In flight now: a later overflow check leaves it alone too.
    await b.enqueue(w, ban);
    expect(await actionStatus(hold.actionId)).toEqual({ status: 'pending', outcome_code: null });
    expect((await queueRows(w)).map((r) => [r.action_id, r.state])).toEqual([
      [ban.actionId, 'queued'],
      [hold.actionId, 'in_flight'],
    ]);
  });

  it('concurrent evictions and abandons on a tiny pool never exhaust it', async () => {
    const tiny = createPool(db.db.url, {
      applicationName: 'yt-backlog-tiny',
      max: 2,
      onIdleError: () => {},
    });
    try {
      const b = new PgYouTubeBacklog({ pool: tiny, clock, cap: 0, log, outcomes: observer });
      const worlds = await Promise.all([0, 1, 2, 3].map((i) => youtubeWorld(`tiny-${i}`)));
      const evicting = [];
      for (const w of worlds)
        for (let i = 0; i < 2; i++) evicting.push({ w, a: await pendingAction(w, 'hide') });
      // cap 0: every enqueue evicts what it queued.
      await Promise.all(evicting.map(({ w, a }) => b.enqueue(w, a)));
      for (const { a } of evicting)
        expect(await actionStatus(a.actionId)).toEqual({
          status: 'failed',
          outcome_code: 'backlog_overflow',
        });

      const big = new PgYouTubeBacklog({ pool: tiny, clock, cap: 100, log, outcomes: observer });
      const abandoning = [];
      for (const w of worlds) {
        const a = await pendingAction(w, 'delete');
        await big.enqueue(w, a);
        abandoning.push(a);
      }
      await Promise.all(worlds.flatMap((w) => [big.abandon(w), big.abandon(w)]));
      for (const a of abandoning)
        expect(await actionStatus(a.actionId)).toEqual({
          status: 'failed',
          outcome_code: 'connection_disconnected',
        });
      expect(outcomes).toHaveLength(evicting.length + abandoning.length);
    } finally {
      await tiny.end();
    }
  });

  it('loadQueued returns queued rows in priority order with their comment', async () => {
    const w = await youtubeWorld('load');
    const b = backlog();
    const parent = await pendingAction(w, 'delete', { state: 'deleted' });
    const reply = await pendingAction(w, 'hide', { parentExternalId: parent.externalId });
    const ban = await pendingAction(w, 'ban_author');
    const flying = await pendingAction(w, 'unhide', { state: 'hidden' });
    for (const a of [reply, ban, flying]) await b.enqueue(w, a);
    await withTransaction(pool, (tx) => b.markInFlight(tx, w, randomUUID(), [flying.actionId]));

    const author = (
      await pool.query<{ external_id: string }>('SELECT external_id FROM author WHERE id = $1', [
        w.authorId,
      ])
    ).rows[0]!.external_id;
    expect(await b.loadQueued(w)).toEqual([
      {
        actionId: ban.actionId,
        kind: 'ban_author',
        requestedAt: ban.requestedAt,
        commentId: ban.commentId,
        commentExternalId: ban.externalId,
        parentExternalId: null,
        parentState: null,
        sourceExternalId: 'dQw4w9WgXcQ',
        authorExternalId: author,
        commentState: 'visible',
        ruleId: null,
      },
      {
        actionId: reply.actionId,
        kind: 'hide',
        requestedAt: reply.requestedAt,
        commentId: reply.commentId,
        commentExternalId: reply.externalId,
        parentExternalId: parent.externalId,
        parentState: 'deleted',
        sourceExternalId: 'dQw4w9WgXcQ',
        authorExternalId: author,
        commentState: 'visible',
        ruleId: null,
      },
    ]);
    expect((await b.loadQueued(w, 1)).map((a) => a.actionId)).toEqual([ban.actionId]);

    await b.requeue(w, [flying.actionId]);
    expect((await b.loadQueued(w)).map((a) => a.actionId)).toContain(flying.actionId);
    await withTransaction(pool, (tx) => b.remove(tx, w, [flying.actionId, ban.actionId]));
    expect((await queueRows(w)).map((r) => r.action_id)).toEqual([reply.actionId]);
  });

  it("loadQueued never returns another brand's rows", async () => {
    const a = await youtubeWorld('brand-a');
    const bWorld = await youtubeWorld('brand-b');
    const b = backlog();
    for (const k of ['ban_author', 'delete', 'hide'] as const)
      await b.enqueue(a, await pendingAction(a, k));
    expect(await b.loadQueued(a)).toHaveLength(3);

    const crossBrand = {
      organizationId: a.organizationId,
      brandId: bWorld.brandId,
      connectionId: a.connectionId,
    };
    const crossOrg = {
      organizationId: bWorld.organizationId,
      brandId: bWorld.brandId,
      connectionId: a.connectionId,
    };
    for (const s of [crossBrand, crossOrg]) {
      expect(await b.loadQueued(s)).toEqual([]);
      expect(await b.counts(s)).toEqual({ ban: 0, reject: 0, hold: 0, publish: 0 });
      await b.requeue(
        s,
        (await queueRows(a)).map((r) => r.action_id),
      );
      await withTransaction(pool, (tx) => b.markInFlight(tx, s, randomUUID(), [randomUUID()]));
      await withTransaction(pool, async (tx) =>
        b.remove(
          tx,
          s,
          (await queueRows(a)).map((r) => r.action_id),
        ),
      );
      await b.abandon(s);
    }
    expect(await queueRows(a)).toHaveLength(3);
    expect(await b.loadQueued(a)).toHaveLength(3);
    expect(outcomes).toEqual([]);
  });

  it('markInFlight only claims queued rows of this scope', async () => {
    const w = await youtubeWorld('claim');
    const b = backlog();
    const x = await pendingAction(w, 'hide');
    const y = await pendingAction(w, 'hide');
    await b.enqueue(w, x);
    await b.enqueue(w, y);
    const batch = randomUUID();
    expect(await withTransaction(pool, (tx) => b.markInFlight(tx, w, batch, [x.actionId]))).toBe(1);
    // A second claim of the same row (a concurrent cycle) gets nothing.
    expect(
      await withTransaction(pool, (tx) =>
        b.markInFlight(tx, w, randomUUID(), [x.actionId, y.actionId]),
      ),
    ).toBe(1);
    const rows = await pool.query<{ action_id: string; batch_id: string | null }>(
      'SELECT action_id, batch_id FROM youtube_action_queue WHERE action_id = $1',
      [x.actionId],
    );
    expect(rows.rows[0]!.batch_id).toBe(batch);
  });

  it('abandon settles queued actions connection_disconnected', async () => {
    const w = await youtubeWorld('abandon');
    const b = backlog();
    const queued = await pendingAction(w, 'delete');
    const flying = await pendingAction(w, 'hide');
    await b.enqueue(w, queued);
    await b.enqueue(w, flying);
    await withTransaction(pool, (tx) => b.markInFlight(tx, w, randomUUID(), [flying.actionId]));

    await b.abandon(w);
    expect(await queueRows(w)).toEqual([]);
    for (const a of [queued, flying])
      expect(await actionStatus(a.actionId)).toEqual({
        status: 'failed',
        outcome_code: 'connection_disconnected',
      });
    expect(outcomes.map((o) => [o.actionId, o.status, o.code]).sort()).toEqual(
      [
        [queued.actionId, 'failed', 'connection_disconnected'],
        [flying.actionId, 'failed', 'connection_disconnected'],
      ].sort(),
    );
    expect(await audits(w)).toHaveLength(2);
    // Repeating it is harmless.
    await b.abandon(w);
    expect(outcomes).toHaveLength(2);
  });
});
