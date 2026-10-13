// Turns one webhook event into stored comment state. The event only says that
// something happened; the comment itself is always re-fetched, so the stored
// row reflects the platform. Ordering safety lives in the store: the sync time
// is taken before the fetch, so a fetch that started earlier never overwrites
// one that started later, and deletes are terminal.
import { clampLag } from '@feedbouncer/service-runtime';
import { JobError, type JobDefinition } from '@feedbouncer/jobs';
import type { Clock, ConnectionDirectory, ConnectorRuntime, Platform } from '@feedbouncer/connectors';
import type { PgCommentStore } from '../store.js';
import { INGEST_JOB, type IngestPayload } from './specs.js';

export type IngestOutcome = 'created' | 'updated' | 'stale' | 'deleted' | 'gone';

export interface IngestObserver {
  onIngested(e: { platform: Platform; lagMs: number; outcome: IngestOutcome }): void;
}

export function ingestCommentJob(d: {
  runtime: ConnectorRuntime;
  directory: ConnectionDirectory;
  store: PgCommentStore;
  clock: Clock;
  observer?: IngestObserver;
}): JobDefinition<IngestPayload> {
  return {
    ...INGEST_JOB,
    platforms: ['facebook'],
    handle: async (ctx, p) => {
      const rec = await d.directory.load(ctx.scope);
      if (!rec) throw new JobError('non_retryable', 'connection_not_found');
      const ref = { sourceExternalId: p.sourceExternalId, externalId: p.commentExternalId };
      const syncedAt = new Date(d.clock.now());
      let outcome: IngestOutcome;
      let commentId: string | null;
      if (p.event === 'deleted') {
        commentId = await d.store.recordDeleted(ctx.scope, ref, {
          syncedAt,
          occurredAt: new Date(p.platformEventSec * 1000),
        });
        outcome = 'deleted';
      } else {
        const client = await d.runtime.connect(ctx.scope);
        const c = await client.getComment(ref);
        if (c === null) {
          // Gone before we could read it: mark a stored copy deleted, store nothing new.
          commentId = await d.store.markDeleted(ctx.scope, ref, syncedAt);
          outcome = 'gone';
        } else {
          const r = await d.store.upsertFromPlatform(ctx.scope, c, {
            ownAccountExternalId: rec.externalAccountId,
            syncedAt,
          });
          commentId = r.commentId;
          outcome = r.created ? 'created' : r.applied ? 'updated' : 'stale';
        }
      }
      const { lagMs } = clampLag(p.platformEventSec * 1000, d.clock.now());
      try {
        d.observer?.onIngested({ platform: rec.platform, lagMs, outcome });
      } catch {
        /* telemetry never fails a job */
      }
      return { outcome, commentId, lagMs };
    },
  };
}
