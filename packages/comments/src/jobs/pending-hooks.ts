import type { Platform } from '@feedbouncer/connectors';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { CommentAppliedHook } from '../hooks.js';
import type { PgCommentStore } from '../store.js';

/** Most pending hook deliveries one job sweeps. */
export const PENDING_SWEEP_LIMIT = 100;

/**
 * Re-delivers the applied hook for comments of one connection whose marker is
 * still set, for example because their ingest job ran out of retries. A failed
 * delivery is recorded so the row rotates behind rows not yet tried; repeat
 * failures are only logged, so one permanent failure cannot fail every job.
 * Returns the error of the first row that had not failed before, if any.
 */
export async function deliverPendingHooks(
  d: { store: PgCommentStore; applied: CommentAppliedHook; now: () => number },
  scope: ConnectionScope,
  platform: Platform,
  log: Logger,
): Promise<{ error: unknown } | null> {
  let failure: { error: unknown } | null = null;
  for (const p of await d.store.pendingHooks(scope, PENDING_SWEEP_LIMIT)) {
    try {
      await d.applied.onApplied({
        scope,
        platform,
        commentId: p.commentId,
        body: p.body,
        outcome: 'updated',
      });
      await d.store.markHookDelivered(scope, p.commentId, p.body);
    } catch (err) {
      await d.store
        .markHookFailed(scope, p.commentId, p.body, new Date(d.now()))
        .catch((markErr: unknown) =>
          log.warn('comments.hook_mark_failed', {
            commentId: p.commentId,
            errorName: markErr instanceof Error ? markErr.name : 'unknown',
          }),
        );
      if (!p.attempted) failure ??= { error: err };
      else
        log.warn('comments.hook_redelivery_failed', {
          commentId: p.commentId,
          errorName: err instanceof Error ? err.name : 'unknown',
        });
    }
  }
  return failure;
}
