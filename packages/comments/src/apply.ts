// One platform comment snapshot into the store; shared by webhook ingest and ad polling.
import type { NormalizedComment } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { PgCommentStore } from './store.js';

export type ApplyOutcome = 'created' | 'updated' | 'stale';

export async function applyPlatformComment(
  store: PgCommentStore,
  scope: ConnectionScope,
  c: NormalizedComment,
  o: { ownAccountExternalId: string; syncedAt: Date; adSourceId?: string },
): Promise<{ commentId: string; outcome: ApplyOutcome }> {
  const r = await store.upsertFromPlatform(scope, c, o);
  // Recorded even for a stale read: the ad path is a fact, not a snapshot.
  if (o.adSourceId !== undefined) await store.markSeenViaAdSource(scope, r.commentId, o.adSourceId);
  return {
    commentId: r.commentId,
    outcome: r.created ? 'created' : r.applied ? 'updated' : 'stale',
  };
}
