// What both TikTok poll jobs share: their settings and dependencies, and
// storing one read comment (applied hook included, as in ad polling).
import { JobError } from '@feedbouncer/jobs';
import type { ConnectorRuntime, NormalizedComment, Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { applyPlatformComment } from '../apply.js';
import type { CommentAppliedHook } from '../hooks.js';
import type { IngestOrigin, PgCommentStore } from '../store.js';
import type { PgTikTokPolling } from './polling.js';

export interface TikTokPollSettings {
  pollIntervalSec: number;
  quietVideoPollIntervalSec: number;
  activeVideoDays: number;
  videoDiscoveryIntervalSec: number;
  deepScanIntervalSec: number;
  sourceUnavailableRetrySec: number;
  maxSourcesPerJob: number;
  adsPollIntervalSec: number;
  adsOverlapSec: number;
  adsFullScanIntervalSec: number;
  maxPagesPerJob: number;
}

export interface TikTokPollDeps {
  readonly runtime: ConnectorRuntime;
  readonly polling: PgTikTokPolling;
  readonly store: PgCommentStore;
  readonly clock: () => Date;
  readonly settings: TikTokPollSettings;
  /** Called for live comments that are new or whose text changed; a throw fails the job after the pass. */
  readonly applied?: CommentAppliedHook;
}

export interface IngestCounts {
  created: number;
  updated: number;
}

export const SEC = 1000;
export const DAY_MS = 86_400_000;

/** The connection the job was enqueued for; null when it is no longer active. */
export async function activeAccount(
  d: TikTokPollDeps,
  scope: ConnectionScope,
  connectionId: string,
): Promise<string | null> {
  if (connectionId !== scope.connectionId) throw new JobError('non_retryable', 'scope_mismatch');
  const acct = await d.polling.account(scope);
  if (!acct) throw new JobError('non_retryable', 'connection_not_found');
  return acct.status === 'active' ? acct.externalAccountId : null;
}

/** Stores one comment (also used by the YouTube poller). Returns whether it was newly created; hook failures land in `failure`. */
export async function ingestComment(
  d: Pick<TikTokPollDeps, 'store' | 'applied' | 'clock'>,
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
          ctx.log.warn('tiktok.hook_mark_failed', {
            commentId: r.commentId,
            errorName: markErr instanceof Error ? markErr.name : 'unknown',
          }),
        );
    }
  }
  return r.outcome === 'created';
}
