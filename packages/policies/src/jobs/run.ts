// policy_run: fans an explicit "apply to recent comments" request out into one
// policy_evaluate job per candidate comment of this connection. The evaluate
// job re-checks the rules and that the revision is still current. Replaying the
// run is harmless: evaluate jobs are deduplicated by comment, body and trigger.
import type pg from 'pg';
import type { JobDefinition, JobProducer } from '@feedbouncer/jobs';
import { recentUndecidedComments } from '../candidates.js';
import { RUN_MAX_COMMENTS_PER_CONNECTION } from '../types.js';
import { POLICY_EVALUATE_JOB, POLICY_RUN_JOB, type PolicyRunPayload } from './specs.js';

export interface RunDeps {
  pool: pg.Pool;
  producer: Pick<JobProducer, 'enqueue'>;
  clock?: { now(): number };
  maxComments?: number;
}

export function policyRunJob(d: RunDeps): JobDefinition<PolicyRunPayload> {
  return {
    ...POLICY_RUN_JOB,
    handle: async (ctx, p) => {
      const brand = { organizationId: ctx.scope.organizationId, brandId: ctx.scope.brandId };
      const { rows } = await d.pool.query<{ since: Date }>(
        `SELECT since FROM policy_run WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
        [brand.organizationId, brand.brandId, p.runId],
      );
      const run = rows[0];
      if (!run) return { result: 'gone' };
      const found = await recentUndecidedComments(d.pool, brand, {
        since: run.since,
        limit: d.maxComments ?? RUN_MAX_COMMENTS_PER_CONNECTION,
        connectionId: ctx.scope.connectionId,
      });
      const requestedAt = d.clock?.now() ?? Date.now();
      for (const c of found) {
        await d.producer.enqueue({
          scope: ctx.scope,
          platform: ctx.platform,
          type: POLICY_EVALUATE_JOB.type,
          payload: {
            commentId: c.commentId,
            bodySha256: c.bodySha256,
            trigger: `run:${p.runId}`,
            requestedAt,
          },
        });
      }
      ctx.log.info('policy.run_enqueued', { runId: p.runId, count: found.length });
      return { result: 'enqueued', count: found.length };
    },
  };
}
