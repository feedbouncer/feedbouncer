// classifier_rerun: fans an explicit re-run out into one comment_classify per
// eligible comment. Each child carries the rerun trigger, so repeating the
// fan-out re-enqueues identical refs and the ledger deduplicates them.
import { JobError, type JobDefinition, type JobProducer } from '@feedbouncer/jobs';
import { bodySha256 } from '@feedbouncer/rules';
import type { Logger } from '@feedbouncer/service-runtime';
import type pg from 'pg';
import {
  CLASSIFIER_RERUN_JOB,
  CLASSIFY_JOB,
  RERUN_MAX_COMMENTS_PER_CONNECTION,
  type RerunPayload,
} from './specs.js';

export interface RerunDeps {
  pool: pg.Pool;
  producer: Pick<JobProducer, 'enqueue'>;
  log: Logger;
  clock?: { now(): number };
  maxComments?: number;
}

const PAGE = 500;
const MAX_WINDOW_MS = 30 * 86_400_000;

export function classifierRerunJob(d: RerunDeps): JobDefinition<RerunPayload> {
  const max = d.maxComments ?? RERUN_MAX_COMMENTS_PER_CONNECTION;
  return {
    ...CLASSIFIER_RERUN_JOB,
    handle: async (ctx, p) => {
      const s = ctx.scope;
      const run = await d.pool.query<{ since: Date }>(
        `SELECT since FROM classifier_run WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
        [s.organizationId, s.brandId, p.runId],
      );
      if (run.rowCount === 0) return { result: 'gone' };
      const now = d.clock?.now() ?? Date.now();
      const since = Math.max(run.rows[0]!.since.getTime(), now - MAX_WINDOW_MS);
      let after = '00000000-0000-0000-0000-000000000000';
      let enqueued = 0;
      let capped = false;
      while (!capped) {
        const room = max - enqueued;
        const page = await d.pool.query<{ id: string; body: string }>(
          `SELECT c.id, c.body FROM comment c
           WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3
             AND c.ingest_origin = 'live' AND c.platform_state <> 'deleted' AND c.is_own_account = false
             AND c.ingested_at >= to_timestamp($4 / 1000.0) AND c.id > $5
           ORDER BY c.id LIMIT $6`,
          [s.organizationId, s.brandId, s.connectionId, since, after, Math.min(PAGE, room + 1)],
        );
        if (page.rows.length === 0) break;
        for (const row of page.rows) {
          if (enqueued >= max) {
            capped = true;
            break;
          }
          if (ctx.signal.aborted) throw new JobError('retryable', 'rerun_timeout');
          await d.producer.enqueue({
            scope: s,
            platform: ctx.platform,
            type: CLASSIFY_JOB.type,
            payload: {
              commentId: row.id,
              bodySha256: bodySha256(row.body),
              trigger: `rerun:${p.runId}`,
              requestedAt: now,
            },
          });
          enqueued += 1;
          after = row.id;
        }
      }
      d.log.info('classifier.rerun.enqueued', {
        runId: p.runId,
        connectionId: s.connectionId,
        enqueued,
      });
      return { enqueued, capped };
    },
  };
}
