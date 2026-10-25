import type pg from 'pg';
import type { ConnectionDirectory, Platform } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { PgBackfillStore } from './backfill/store.js';
import type { PgYouTubeBacklog } from './youtube/backlog.js';
import { LIFECYCLE_JOB } from './jobs/specs.js';

const AUDIT_ACTION = {
  setup: 'connection.authorized',
  teardown: 'connection.disconnected',
} as const;

/**
 * Enqueues the platform-side setup (after a connect) or teardown (after a
 * disconnect). The nonce is the connection id plus the audit sequence of the
 * event that caused it: unique per (re)connect or disconnect, and stable across
 * retries, so a repeated request deduplicates. False when there is no such event.
 * An operator re-queue passes `idempotencyKey` to get a job of its own instead of
 * deduplicating against the original, possibly dead-lettered, one.
 */
export async function enqueueLifecycle(
  pool: pg.Pool,
  producer: Pick<JobProducer, 'enqueue'>,
  scope: ConnectionScope,
  platform: Platform,
  op: 'setup' | 'teardown',
  idempotencyKey?: string,
): Promise<boolean> {
  const r = await pool.query<{ sequence: string | null }>(
    `SELECT max(sequence)::text AS sequence FROM audit_event
      WHERE organization_id = $1 AND brand_id = $2 AND subject_type = 'connection'
        AND subject_id = $3 AND action = $4`,
    [scope.organizationId, scope.brandId, scope.connectionId, AUDIT_ACTION[op]],
  );
  const sequence = r.rows[0]?.sequence ?? null;
  if (sequence === null) return false;
  await producer.enqueue({
    scope,
    platform,
    type: LIFECYCLE_JOB.type,
    payload: { op, nonce: `${scope.connectionId}:${sequence}` },
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  });
  return true;
}

/**
 * The local half of a disconnect: revokes the connection and cancels its
 * backfill. True when the platform-side teardown (`enqueueLifecycle`) should be
 * queued next: this call disconnected it, or it was already disconnected by a
 * user (a retry, whose teardown deduplicates). False for a row revoked for any
 * other reason by a concurrent change (a reconnect), which is left alone.
 * A null actor is an operator. A YouTube connection's queued actions settle
 * failed / connection_disconnected here; a failure throws, and the repeated call finishes it.
 */
export async function revokeConnection(
  d: {
    pool: pg.Pool;
    directory: Pick<ConnectionDirectory, 'disconnect'>;
    backfill: Pick<PgBackfillStore, 'cancel'>;
    backlog: Pick<PgYouTubeBacklog, 'abandon'>;
    log: Logger;
  },
  scope: ConnectionScope,
  actorUserId: string | null,
): Promise<boolean> {
  if (
    !(await d.directory.disconnect(scope, actorUserId)) &&
    !(await isUserDisconnected(d.pool, scope))
  )
    return false;
  try {
    await d.backfill.cancel(scope, new Date());
  } catch (err) {
    // The runtime refuses a revoked connection, so platform calls stop anyway.
    d.log.warn('backfill cancel failed', {
      connectionId: scope.connectionId,
      errorName: err instanceof Error ? err.name : 'NonError',
    });
  }
  if ((await platformOf(d.pool, scope)) === 'youtube') await d.backlog.abandon(scope);
  return true;
}

async function platformOf(pool: pg.Pool, scope: ConnectionScope): Promise<string | undefined> {
  const r = await pool.query<{ platform: string }>(
    `SELECT platform FROM connection WHERE id = $3 AND organization_id = $1 AND brand_id = $2`,
    [scope.organizationId, scope.brandId, scope.connectionId],
  );
  return r.rows[0]?.platform;
}

async function isUserDisconnected(pool: pg.Pool, scope: ConnectionScope): Promise<boolean> {
  const r = await pool.query<{ status: string; status_reason: string | null }>(
    `SELECT status, status_reason FROM connection
      WHERE id = $3 AND organization_id = $1 AND brand_id = $2`,
    [scope.organizationId, scope.brandId, scope.connectionId],
  );
  const row = r.rows[0];
  return row?.status === 'revoked' && row.status_reason === 'user_disconnected';
}
