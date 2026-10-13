import type pg from 'pg';
import { LIFECYCLE_JOB } from '@feedbouncer/comments';
import type { Platform } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';

const AUDIT_ACTION = {
  setup: 'connection.authorized',
  teardown: 'connection.disconnected',
} as const;

/**
 * Enqueues the platform-side setup (after a connect) or teardown (after a
 * disconnect). The nonce is the connection id plus the audit sequence of the
 * event that caused it: unique per (re)connect or disconnect, and stable across
 * retries, so a repeated request deduplicates. False when there is no such event.
 */
export async function enqueueLifecycle(
  pool: pg.Pool,
  producer: Pick<JobProducer, 'enqueue'>,
  scope: ConnectionScope,
  platform: Platform,
  op: 'setup' | 'teardown',
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
  });
  return true;
}
