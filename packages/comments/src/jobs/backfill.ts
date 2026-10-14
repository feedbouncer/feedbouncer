// Imports a connection's recent comments once after (re)connect. Read-only toward
// the platform, background priority, checkpointed after every page. A segment that
// reaches its soft deadline enqueues the next one; throttling and transient errors
// are left to the job framework, which re-runs the segment from the checkpoint.
import type { JobDefinition, JobProducer } from '@feedbouncer/jobs';
import {
  ConnectorError,
  type Clock,
  type ConnectionDirectory,
  type ConnectorRuntime,
} from '@feedbouncer/connectors';
import type { PgCommentStore } from '../store.js';
import { applyPlatformComment } from '../apply.js';
import type { PgBackfillStore } from '../backfill/store.js';
import { BACKFILL_DEFAULTS, type BackfillSettings } from '../backfill/settings.js';
import type { IngestObserver } from './ingest.js';
import { sourceFailure } from './poll.js';
import { BACKFILL_JOB, type BackfillPayload } from './specs.js';

export type BackfillOutcome =
  | { result: 'completed'; imported: number; limited: boolean }
  | { result: 'continued'; imported: number; nextSegment: number }
  | {
      result: 'stopped';
      reason:
        | 'not_current'
        | 'cancelled'
        | 'reconnect_required'
        | 'disconnected'
        | 'source_listing_forbidden'
        | 'platform_error';
    };

export function connectionBackfillJob(d: {
  runtime: ConnectorRuntime;
  directory: ConnectionDirectory;
  store: PgCommentStore;
  backfill: PgBackfillStore;
  producer: Pick<JobProducer, 'enqueue'>;
  clock: Clock;
  settings?: BackfillSettings;
  observer?: IngestObserver;
}): JobDefinition<BackfillPayload> {
  const s = d.settings ?? BACKFILL_DEFAULTS;
  const at = () => new Date(d.clock.now());
  return {
    ...BACKFILL_JOB,
    handle: async (ctx, p): Promise<BackfillOutcome> => {
      const scope = ctx.scope;
      const rec = await d.directory.load(scope);
      if (!rec) return { result: 'stopped', reason: 'not_current' };
      if (rec.status !== 'active') {
        const reason = rec.status === 'revoked' ? 'disconnected' : 'reconnect_required';
        await d.backfill.fail(scope, p.runId, reason, at());
        return { result: 'stopped', reason };
      }
      const run = await d.backfill.claim(scope, p.runId, p.segment, at());
      if (!run) return { result: 'stopped', reason: 'not_current' };
      const client = await d.runtime.connect(scope);
      const deadline = d.clock.now() + s.softDeadlineMs;
      let queue = [...run.sourceQueue];
      let sourceCursor = run.sourceCursor;
      let exhausted = run.sourcesExhausted;
      let commentCursor = run.commentCursor;
      let imported = run.importedCount;

      const save = (c: {
        importedDelta?: number;
        sourcesDoneDelta?: number;
        skipped?: { source: string; code: string };
      }) =>
        d.backfill.checkpoint(
          scope,
          p.runId,
          {
            sourceCursor,
            sourcesExhausted: exhausted,
            sourceQueue: queue,
            commentCursor,
            importedDelta: c.importedDelta ?? 0,
            sourcesDoneDelta: c.sourcesDoneDelta ?? 0,
            ...(c.skipped ? { skipped: c.skipped } : {}),
          },
          at(),
        );
      const stopOnAuth = async (ce: ConnectorError): Promise<BackfillOutcome> => {
        const reason = ce.code === 'connection_revoked' ? 'disconnected' : 'reconnect_required';
        await d.backfill.fail(scope, p.runId, reason, at());
        return { result: 'stopped', reason };
      };

      for (;;) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (imported >= run.maxComments) {
          await d.backfill.complete(scope, p.runId, { limited: true }, at());
          return { result: 'completed', imported, limited: true };
        }

        if (queue.length === 0) {
          if (exhausted) {
            await d.backfill.complete(scope, p.runId, { limited: false }, at());
            return { result: 'completed', imported, limited: false };
          }
          try {
            const page = await client.listRecentSources(
              { since: run.windowStart, cursor: sourceCursor, limit: s.pageSize },
              { priority: 'background' },
            );
            queue = page.items.map((x) => x.externalId);
            sourceCursor = page.nextCursor;
            exhausted = page.nextCursor === null;
          } catch (err) {
            if (!(err instanceof ConnectorError)) throw err;
            if (err.kind === 'auth_expired') return stopOnAuth(err);
            if (err.kind === 'permanent') {
              const reason =
                err.code === 'permission_denied' ? 'source_listing_forbidden' : 'platform_error';
              await d.backfill.fail(scope, p.runId, reason, at());
              return { result: 'stopped', reason };
            }
            throw err;
          }
          if (!(await save({}))) return { result: 'stopped', reason: 'cancelled' };
          continue;
        }

        const src = queue[0]!;
        const syncedAt = at(); // before the fetch: any later live write wins
        let applied = 0;
        let sourceDone: boolean;
        let next: string | null;
        try {
          const page = await client.listComments(
            {
              sourceExternalId: src,
              cursor: commentCursor,
              limit: s.pageSize,
              includeReplies: true,
            },
            { priority: 'background' },
          );
          let capHit = false;
          for (const c of page.items) {
            if (c.postedAt < run.windowStart) continue;
            if (imported + applied >= run.maxComments) {
              capHit = true;
              break;
            }
            const r = await applyPlatformComment(d.store, scope, c, {
              ownAccountExternalId: rec.externalAccountId,
              syncedAt,
              origin: 'backfill',
            });
            applied++;
            try {
              d.observer?.onIngested({
                platform: rec.platform,
                lagMs: 0,
                outcome: r.outcome,
                origin: 'backfill',
              });
            } catch {
              /* telemetry never fails a job */
            }
          }
          const passed = page.items.some(
            (c) => c.parentExternalId === null && c.postedAt < run.windowStart,
          );
          sourceDone = capHit || passed || page.nextCursor === null;
          if (!sourceDone && page.nextCursor === commentCursor)
            throw new ConnectorError('permanent', 'cursor_stalled');
          next = sourceDone ? null : page.nextCursor;
        } catch (err) {
          if (!(err instanceof ConnectorError)) throw err;
          if (err.kind === 'auth_expired') return stopOnAuth(err);
          if (sourceFailure(err)) {
            imported += applied;
            queue = queue.slice(1);
            commentCursor = null;
            const code = err.kind === 'not_found' ? 'source_missing' : err.code;
            if (
              !(await save({
                importedDelta: applied,
                sourcesDoneDelta: 1,
                skipped: { source: src, code },
              }))
            )
              return { result: 'stopped', reason: 'cancelled' };
            continue;
          }
          throw err;
        }

        imported += applied;
        if (sourceDone) queue = queue.slice(1);
        commentCursor = next;
        if (!(await save({ importedDelta: applied, sourcesDoneDelta: sourceDone ? 1 : 0 })))
          return { result: 'stopped', reason: 'cancelled' };
        if (d.clock.now() >= deadline) {
          await d.producer.enqueue({
            scope,
            platform: rec.platform,
            type: BACKFILL_JOB.type,
            payload: { runId: p.runId, segment: p.segment + 1 },
          });
          return { result: 'continued', imported, nextSegment: p.segment + 1 };
        }
      }
    },
  };
}
