// Stores one comment read by a poller and hands it to the rule hook.
import type { NormalizedComment, Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { applyPlatformComment } from './apply.js';
import type { CommentAppliedHook } from './hooks.js';
import type { IngestOrigin, PgCommentStore } from './store.js';

export interface IngestCounts {
  created: number;
  updated: number;
}

/** Stores one polled comment and hands it to the rule hook. Returns whether it was newly created; hook failures land in `failure`. */
export async function ingestComment(
  d: {
    store: PgCommentStore;
    applied?: CommentAppliedHook | undefined;
    clock: () => Date;
  },
  ctx: { scope: ConnectionScope; platform: Platform; log: Logger },
  c: NormalizedComment,
  o: { ownAccountExternalId: string; syncedAt: Date; origin: IngestOrigin },
  counts: IngestCounts,
  failure: { error?: unknown },
): Promise<boolean> {
  const r = await applyPlatformComment(d.store, ctx.scope, c, o);
  if (r.suppressed) {
    ctx.log.info('comment.ingest_suppressed', { connectionId: ctx.scope.connectionId });
    return false;
  }
  if (r.outcome === 'created') counts.created++;
  else if (r.outcome === 'updated') counts.updated++;
  if (d.applied && r.hookBody !== null) {
    try {
      await d.applied.onApplied({
        scope: ctx.scope,
        platform: ctx.platform,
        commentId: r.commentId,
        body: r.hookBody,
        outcome: r.outcome === 'created' ? 'created' : 'updated',
      });
      await d.store.markHookDelivered(ctx.scope, r.commentId, r.hookBody);
    } catch (err) {
      if (!('error' in failure)) failure.error = err;
      await d.store
        .markHookFailed(ctx.scope, r.commentId, r.hookBody, d.clock())
        .catch((markErr: unknown) =>
          ctx.log.warn('comment.hook_mark_failed', {
            commentId: r.commentId,
            errorName: markErr instanceof Error ? markErr.name : 'unknown',
          }),
        );
    }
  }
  return r.outcome === 'created';
}
