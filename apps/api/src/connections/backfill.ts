import { BACKFILL_JOB, isBackfillPlatform, type PgBackfillStore } from '@feedbouncer/comments';
import type { Platform } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';

/** Starts or re-queues the connection's backfill run. Repeats dedupe on the run's segment ref. */
export async function requestBackfill(
  store: PgBackfillStore,
  producer: Pick<JobProducer, 'enqueue'>,
  scope: ConnectionScope,
  platform: Platform,
  now: Date,
): Promise<void> {
  if (!isBackfillPlatform(platform)) return;
  const r = await store.request(scope, now);
  if (r.kind === 'up_to_date') return;
  await producer.enqueue({
    scope,
    platform,
    type: BACKFILL_JOB.type,
    payload: { runId: r.runId, segment: r.segment },
  });
}
