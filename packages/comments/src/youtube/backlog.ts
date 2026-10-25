// The persistent YouTube action backlog. `ModerationActions` puts pending
// YouTube actions here instead of enqueueing the execute job; the cycle plans
// and sends them in budgeted batches. Every statement is filtered by
// organization_id + brand_id (+ connection_id).
// A row leaves the queue in the same transaction that settles its action (or
// by the dispatcher once it settled it), so a crash never strands a pending
// action without a queue row. Rows whose action is no longer pending are never loaded or claimed.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { Clock, PlatformState } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ActionActor, ActionKind } from '../action-kinds.js';
import type { BudgetedDispatch } from '../actions.js';
import type { ActionOutcomeObserver } from '../hooks.js';
import { notifyOutcome, settleActionIn, type SettleTarget } from '../jobs/settle.js';
import { TIER, type QueuedAction, type QueuedKind } from './planner.js';
import { pacificDayKey } from './quota-day.js';

/** YOUTUBE_BACKLOG_CAP default. */
export const DEFAULT_BACKLOG_CAP = 5000;
export const LOAD_LIMIT = 2500;

export interface YouTubeBacklogDeps {
  pool: pg.Pool;
  clock: Clock;
  /** Most actions kept per connection; beyond it the lowest tier, newest first, are evicted. */
  cap: number;
  log: Logger;
  outcomes?: ActionOutcomeObserver;
}

export interface BacklogCounts {
  ban: number;
  reject: number;
  hold: number;
  publish: number;
}

type Queryable = Pick<pg.ClientBase, 'query'>;

const scopeParams = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];

const isQueuedKind = (k: string): k is QueuedKind => Object.hasOwn(TIER, k);

/** Queue rows joined to their pending action, comment and source, all within the scope. */
const QUEUE_JOIN = `
  FROM youtube_action_queue q
  JOIN moderation_action m ON m.id = q.action_id AND m.organization_id = q.organization_id
                          AND m.brand_id = q.brand_id AND m.connection_id = q.connection_id
  JOIN comment c ON c.id = q.comment_id AND c.organization_id = q.organization_id
                AND c.brand_id = q.brand_id AND c.connection_id = q.connection_id
  JOIN source s ON s.id = c.source_id AND s.organization_id = q.organization_id
               AND s.brand_id = q.brand_id AND s.connection_id = q.connection_id`;

const SCOPED = 'q.organization_id = $1 AND q.brand_id = $2 AND q.connection_id = $3';

export class PgYouTubeBacklog implements BudgetedDispatch {
  constructor(private readonly d: YouTubeBacklogDeps) {}

  /** Idempotent per action id: a replay of a queued or in-flight action changes nothing. */
  async enqueue(
    scope: ConnectionScope,
    a: { actionId: string; commentId: string; kind: ActionKind; requestedAt: Date },
  ): Promise<void> {
    if (!isQueuedKind(a.kind)) throw new TypeError('youtube_backlog_unsupported_kind');
    const params = [...scopeParams(scope), a.actionId, a.commentId, a.kind];
    const r = await this.d.pool.query(
      `INSERT INTO youtube_action_queue (action_id, organization_id, brand_id, connection_id,
                                         comment_id, tier, requested_at)
       SELECT m.id, m.organization_id, m.brand_id, m.connection_id, m.comment_id, $7, $8
         FROM moderation_action m
        WHERE m.id = $4 AND m.organization_id = $1 AND m.brand_id = $2 AND m.connection_id = $3
          AND m.comment_id = $5 AND m.kind = $6 AND m.status = 'pending'
       ON CONFLICT (action_id) DO NOTHING`,
      [...params, TIER[a.kind], a.requestedAt],
    );
    if (r.rowCount === 0) {
      // Already queued, or settled meanwhile: nothing to do. Anything else is a caller bug.
      const known = await this.d.pool.query(
        `SELECT 1 FROM moderation_action m
          WHERE m.id = $4 AND m.organization_id = $1 AND m.brand_id = $2 AND m.connection_id = $3
            AND m.comment_id = $5 AND m.kind = $6`,
        params,
      );
      if (known.rowCount === 0) throw new Error('youtube_backlog_action_not_found');
    }
    await this.#enforceCap(scope);
  }

  /** Queued (not in-flight) actions in priority order, with what the planner needs. */
  async loadQueued(scope: ConnectionScope, limit = LOAD_LIMIT): Promise<QueuedAction[]> {
    const r = await this.d.pool.query<{
      action_id: string;
      kind: string;
      requested_at: Date;
      comment_id: string;
      comment_external_id: string;
      parent_external_id: string | null;
      parent_state: PlatformState | null;
      source_external_id: string;
      author_external_id: string | null;
      platform_state: PlatformState;
      rule_id: string | null;
    }>(
      `SELECT q.action_id, m.kind, q.requested_at, q.comment_id, c.external_id AS comment_external_id,
              c.parent_external_id, p.platform_state AS parent_state,
              s.external_id AS source_external_id, a.external_id AS author_external_id,
              c.platform_state, m.rule_id
       ${QUEUE_JOIN}
       LEFT JOIN author a ON a.id = c.author_id AND a.organization_id = q.organization_id
                         AND a.brand_id = q.brand_id AND a.connection_id = q.connection_id
       LEFT JOIN comment p ON p.external_id = c.parent_external_id
                          AND p.organization_id = q.organization_id AND p.brand_id = q.brand_id
                          AND p.connection_id = q.connection_id
       WHERE ${SCOPED} AND q.state = 'queued' AND m.status = 'pending'
       ORDER BY q.tier, q.requested_at, q.action_id
       LIMIT $4`,
      [...scopeParams(scope), Math.max(0, Math.floor(limit))],
    );
    return r.rows.flatMap((x) =>
      isQueuedKind(x.kind)
        ? [
            {
              actionId: x.action_id,
              kind: x.kind,
              requestedAt: x.requested_at,
              commentId: x.comment_id,
              commentExternalId: x.comment_external_id,
              parentExternalId: x.parent_external_id,
              parentState: x.parent_external_id === null ? null : x.parent_state,
              sourceExternalId: x.source_external_id,
              authorExternalId: x.author_external_id,
              commentState: x.platform_state,
              ruleId: x.rule_id,
            },
          ]
        : [],
    );
  }

  /** Claims queued rows of pending actions for a batch. Returns how many were claimed. */
  async markInFlight(
    tx: Queryable,
    scope: ConnectionScope,
    batchId: string,
    actionIds: readonly string[],
  ): Promise<number> {
    const r = await tx.query(
      `UPDATE youtube_action_queue q SET state = 'in_flight', batch_id = $4
         FROM moderation_action m
        WHERE ${SCOPED} AND q.action_id = ANY($5::uuid[]) AND q.state = 'queued'
          AND m.id = q.action_id AND m.organization_id = q.organization_id
          AND m.brand_id = q.brand_id AND m.connection_id = q.connection_id
          AND m.status = 'pending'`,
      [...scopeParams(scope), batchId, actionIds],
    );
    return r.rowCount ?? 0;
  }

  /** Puts actions back in the queue for a later cycle. */
  async requeue(scope: ConnectionScope, actionIds: readonly string[]): Promise<void> {
    await this.d.pool.query(
      `UPDATE youtube_action_queue q SET state = 'queued', batch_id = NULL
        WHERE ${SCOPED} AND q.action_id = ANY($4::uuid[])`,
      [...scopeParams(scope), actionIds],
    );
  }

  /** Drops settled actions from the queue. */
  async remove(tx: Queryable, scope: ConnectionScope, actionIds: readonly string[]): Promise<void> {
    await tx.query(
      `DELETE FROM youtube_action_queue q WHERE ${SCOPED} AND q.action_id = ANY($4::uuid[])`,
      [...scopeParams(scope), actionIds],
    );
  }

  /** On disconnect: every queued or in-flight action settles failed / connection_disconnected. */
  async abandon(scope: ConnectionScope): Promise<void> {
    const r = await this.d.pool.query<{ action_id: string }>(
      `SELECT q.action_id FROM youtube_action_queue q WHERE ${SCOPED}
        ORDER BY q.tier, q.requested_at, q.action_id`,
      scopeParams(scope),
    );
    await this.#fail(
      scope,
      r.rows.map((x) => x.action_id),
      'connection_disconnected',
      'all_wait',
    );
  }

  /** Queued and in-flight actions per tier. */
  async counts(scope: ConnectionScope): Promise<BacklogCounts> {
    const r = await this.d.pool.query<{ tier: number; n: number }>(
      `SELECT q.tier, count(*)::int AS n FROM youtube_action_queue q WHERE ${SCOPED} GROUP BY q.tier`,
      scopeParams(scope),
    );
    const n = (t: number) => r.rows.find((x) => x.tier === t)?.n ?? 0;
    return { ban: n(0), reject: n(1), hold: n(2), publish: n(3) };
  }

  async #enforceCap(scope: ConnectionScope): Promise<void> {
    const r = await this.d.pool.query<{ action_id: string }>(
      `SELECT action_id FROM (
         SELECT q.action_id, q.state, q.tier, q.requested_at,
                row_number() OVER (ORDER BY q.tier, q.requested_at, q.action_id) AS rank
           FROM youtube_action_queue q WHERE ${SCOPED}) ranked
        WHERE rank > $4 AND state = 'queued'
        ORDER BY tier DESC, requested_at DESC, action_id DESC`,
      [...scopeParams(scope), Math.max(0, Math.floor(this.d.cap))],
    );
    if (r.rows.length === 0) return;
    const evicted = await this.#fail(
      scope,
      r.rows.map((x) => x.action_id),
      'backlog_overflow',
      'queued_skip_locked',
    );
    if (evicted === 0) return;
    await this.d.pool.query(
      `INSERT INTO youtube_notice AS n (connection_id, kind, pacific_day, organization_id, brand_id, count)
       VALUES ($3, 'backlog_overflow', $4::date, $1, $2, $5)
       ON CONFLICT (connection_id, kind, pacific_day) DO UPDATE SET count = n.count + EXCLUDED.count
       WHERE n.organization_id = $1 AND n.brand_id = $2`,
      [...scopeParams(scope), pacificDayKey(this.d.clock.now()), evicted],
    );
    this.d.log.warn('youtube.backlog_overflow', {
      connectionId: scope.connectionId,
      evicted,
    });
  }

  /**
   * Settles each action failed with `code` and drops its queue row, in one
   * transaction on one connection: the row lock, the settle and the deletion
   * commit together or not at all. Returns how many this call recorded.
   */
  async #fail(
    scope: ConnectionScope,
    actionIds: readonly string[],
    code: string,
    lock: 'queued_skip_locked' | 'all_wait',
  ): Promise<number> {
    if (actionIds.length === 0) return 0;
    // The queue rows stay locked until their deletion commits, so a cycle cannot
    // claim (markInFlight) a row being failed here. Eviction takes only rows still
    // queued and skips any a cycle is claiming right now; abandon takes all.
    const settled = await withTransaction(this.d.pool, async (tx) => {
      const locked = await tx.query<{ action_id: string }>(
        `SELECT q.action_id FROM youtube_action_queue q
          WHERE ${SCOPED} AND q.action_id = ANY($4::uuid[])
          ${lock === 'queued_skip_locked' ? "AND q.state = 'queued'" : ''}
          ORDER BY q.action_id
          FOR UPDATE${lock === 'queued_skip_locked' ? ' SKIP LOCKED' : ''}`,
        [...scopeParams(scope), actionIds],
      );
      const lockedIds = new Set(locked.rows.map((x) => x.action_id));
      const targets = await this.#targets(
        tx,
        scope,
        actionIds.filter((id) => lockedIds.has(id)),
      );
      const recorded: SettleTarget[] = [];
      for (const t of targets) {
        const s = await settleActionIn(tx, scope, t, {
          status: 'failed',
          code,
          platformRef: null,
          undo: null,
          commentState: null,
          resync: false,
        });
        await this.remove(tx, scope, [t.id]);
        if (s.recorded) recorded.push(t);
      }
      return recorded;
    });
    for (const t of settled) await notifyOutcome(this.d, scope, 'youtube', t, 'failed', code);
    return settled.length;
  }

  async #targets(
    q: Queryable,
    scope: ConnectionScope,
    actionIds: readonly string[],
  ): Promise<SettleTarget[]> {
    if (actionIds.length === 0) return [];
    const r = await q.query<{
      id: string;
      comment_id: string;
      kind: ActionKind;
      actor_type: ActionActor['type'];
      actor_user_id: string | null;
      actor_api_key_id: string | null;
      rule_id: string | null;
      request_key: string;
      comment_external_id: string;
      source_external_id: string;
    }>(
      `SELECT m.id, m.comment_id, m.kind, m.actor_type, m.actor_user_id, m.actor_api_key_id,
              m.rule_id, m.request_key, c.external_id AS comment_external_id,
              s.external_id AS source_external_id
       ${QUEUE_JOIN}
       WHERE ${SCOPED} AND q.action_id = ANY($4::uuid[])`,
      [...scopeParams(scope), actionIds],
    );
    const byId = new Map(r.rows.map((x) => [x.id, x]));
    // Keep the caller's order (eviction order).
    return actionIds.flatMap((id) => {
      const x = byId.get(id);
      return x
        ? [
            {
              id: x.id,
              commentId: x.comment_id,
              kind: x.kind,
              actorType: x.actor_type,
              actorUserId: x.actor_user_id,
              actorApiKeyId: x.actor_api_key_id,
              ruleId: x.rule_id,
              requestKey: x.request_key,
              commentExternalId: x.comment_external_id,
              sourceExternalId: x.source_external_id,
            },
          ]
        : [];
    });
  }
}
