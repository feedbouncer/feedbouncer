// policy_preview: checks a draft policy text against recent undecided comments
// and stores what it would do. Dry run by construction: the dependencies have no
// way to request a platform action or write a decision or evaluation.
// Logs carry ids and closed codes only.
import { JobDeferral, JobError, type JobContext, type JobDefinition } from '@feedbouncer/jobs';
import type { PgCommentStore } from '@feedbouncer/comments';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { mapProviderError, prepareInput } from '@feedbouncer/ai';
import type { BrandSlots } from '@feedbouncer/db';
import { effectiveAction } from '../decide.js';
import { describePreviewResult } from '../describe.js';
import type { PolicyEvaluator } from '../evaluator.js';
import type { PgPolicyPreviewStore } from '../previews.js';
import type { PolicyVerdict } from '../types.js';
import type { PgPolicyUsage } from '../usage.js';
import {
  MAX_POLICY_PROVIDER_ATTEMPTS,
  POLICY_BRAND_BUSY_RETRY_MS,
  POLICY_PREVIEW_JOB,
  PREVIEW_CHUNK,
  type PolicyPreviewPayload,
} from './specs.js';

export interface PreviewDeps {
  comments: Pick<PgCommentStore, 'load'>;
  previews: PgPolicyPreviewStore;
  evaluator: PolicyEvaluator;
  slots: Pick<BrandSlots, 'acquire'>;
  usage: Pick<PgPolicyUsage, 'consume'>;
  monthlyCallsPerBrand: number;
  next: (
    scope: ConnectionScope,
    platform: JobContext['platform'],
    p: PolicyPreviewPayload,
  ) => Promise<void>;
}

export function policyPreviewJob(d: PreviewDeps): JobDefinition<PolicyPreviewPayload> {
  return {
    ...POLICY_PREVIEW_JOB,
    handle: async (ctx, p) => {
      const brand = { organizationId: ctx.scope.organizationId, brandId: ctx.scope.brandId };
      const pv = await d.previews.load(brand, p.previewId);
      if (!pv || pv.status !== 'running') return { result: 'gone' };
      if (!d.evaluator.enabled) {
        await d.previews.stop(brand, pv.id, 'evaluator_disabled');
        return { result: 'stopped' };
      }
      const rows = await d.previews.pending(ctx.scope, pv.id, PREVIEW_CHUNK);
      for (const r of rows) {
        const c = await d.comments.load(brand, r.commentId);
        if (!c || c.connectionId !== ctx.scope.connectionId || c.platformState === 'deleted') {
          await d.previews.saveResult(ctx.scope, r.resultId, {
            verdict: 'skipped',
            proposedAction: null,
            reason: null,
            errorCode: null,
          });
          continue;
        }
        const input = prepareInput(c.body);
        let verdict: PolicyVerdict = 'no_match';
        if (!input.empty) {
          const lease = await d.slots.acquire(brand.brandId);
          if (!lease) throw new JobDeferral('policy_brand_busy', POLICY_BRAND_BUSY_RETRY_MS);
          try {
            if (!(await d.usage.consume(brand, d.monthlyCallsPerBrand))) {
              await d.previews.stop(brand, pv.id, 'quota_exhausted');
              return { result: 'stopped' };
            }
            verdict = (
              await d.evaluator.evaluate(input, [{ key: 'p1', text: pv.text }], ctx.signal)
            ).p1!;
          } catch (e) {
            const err = mapProviderError(e);
            if (err.retryable && ctx.attempt < MAX_POLICY_PROVIDER_ATTEMPTS) {
              ctx.log.warn('policy.preview_retry', {
                previewId: pv.id,
                code: err.code,
                attempt: ctx.attempt,
              });
              throw new JobError('retryable', `policy_${err.code}`);
            }
            ctx.log.warn('policy.preview_comment_failed', { previewId: pv.id, code: err.code });
            await d.previews.saveResult(ctx.scope, r.resultId, {
              verdict: 'error',
              proposedAction: null,
              reason: null,
              errorCode: err.code,
            });
            continue;
          } finally {
            await lease
              .release()
              .catch(() => ctx.log.warn('policy.slot_release_failed', { previewId: pv.id }));
          }
        }
        const e = effectiveAction(pv.action, verdict, {
          lowSignal: input.lowSignal,
          moderatorActed: false,
        });
        await d.previews.saveResult(
          ctx.scope,
          r.resultId,
          e
            ? {
                verdict,
                proposedAction: e.effectiveAction,
                reason: describePreviewResult(
                  { verdict, action: pv.action, ...e },
                  { truncated: input.truncated },
                ),
                errorCode: null,
              }
            : { verdict: 'no_match', proposedAction: null, reason: null, errorCode: null },
        );
      }
      // A full chunk may be followed by more rows; a short one is the last.
      if (rows.length === PREVIEW_CHUNK)
        await d.next(ctx.scope, ctx.platform, { previewId: pv.id, chunk: p.chunk + 1 });
      else await d.previews.completeIfDone(brand, pv.id);
      return { result: 'processed', count: rows.length };
    },
  };
}
