// policy_evaluate: checks one stored comment body against the brand's enabled
// policies (or one policy, for an explicit run) when no rule decided it, and asks
// for the resulting platform action. Repeating it is safe: the evaluation is
// unique per (comment, body version, trigger), the action is deduplicated by its
// request key and the fallback flag is written once.
// Logs carry ids and closed codes only: never comment text, policy text or model output.
import {
  JobDeferral,
  JobError,
  type JobContext,
  type JobDefinition,
  type JobResult,
} from '@feedbouncer/jobs';
import { stepsForOutcome, type PgSuggestionStore } from '@feedbouncer/actions';
import {
  actionFallbackCode,
  type CommentRow,
  type ModerationActions,
  type PgCommentStore,
  type PgReviewModeReader,
} from '@feedbouncer/comments';
import { bodySha256, type BrandScope, type PgEvaluationStore } from '@feedbouncer/rules';
import { mapProviderError, prepareInput, type ModelUsage } from '@feedbouncer/ai';
import type { BrandSlots } from '@feedbouncer/db';
import type { Logger } from '@feedbouncer/service-runtime';
import { runPolicyCheck } from '../check.js';
import { describeDecision, describeFallback } from '../describe.js';
import type { EvaluationRecord, EvaluationRow, PgPolicyEvaluationStore } from '../evaluations.js';
import { POLICY_PROMPT_VERSION, type PolicyEvaluator } from '../evaluator.js';
import type { PgPolicyStore } from '../store.js';
import type { ActivePolicy, FailureCode } from '../types.js';
import type { PgPolicyUsage } from '../usage.js';
import {
  MAX_POLICY_PROVIDER_ATTEMPTS,
  POLICY_BRAND_BUSY_RETRY_MS,
  POLICY_EVALUATE_JOB,
  type PolicyEvaluatePayload,
} from './specs.js';

export interface PolicyEvaluateDeps {
  comments: Pick<PgCommentStore, 'load' | 'latestActionActor'>;
  ruleEvaluations: Pick<PgEvaluationStore, 'find'>;
  policies: Pick<PgPolicyStore, 'enabledForEvaluation' | 'forRun'>;
  evaluations: PgPolicyEvaluationStore;
  usage: Pick<PgPolicyUsage, 'consume'>;
  evaluator: PolicyEvaluator;
  slots: Pick<BrandSlots, 'acquire'>;
  actions: Pick<ModerationActions, 'request'>;
  suggestions: Pick<PgSuggestionStore, 'propose'>;
  reviewMode: Pick<PgReviewModeReader, 'isActive'>;
  monthlyCallsPerBrand: number;
  maxWaitMs: number;
  log: Logger;
  clock?: { now(): number };
}

export function policyEvaluateJob(d: PolicyEvaluateDeps): JobDefinition<PolicyEvaluatePayload> {
  const now = () => d.clock?.now() ?? Date.now();

  async function evaluateOnce(
    ctx: JobContext,
    p: PolicyEvaluatePayload,
    row: CommentRow,
    sha: Buffer,
    brand: BrandScope,
  ): Promise<EvaluationRecord | 'no_policies'> {
    const base = { commentId: row.id, sha, triggerKey: p.trigger };
    if (row.platformState === 'deleted')
      return { ...base, status: 'skipped', skipReason: 'deleted', ruleEvaluationId: null };
    if (row.isOwnAccount)
      return { ...base, status: 'skipped', skipReason: 'own_account', ruleEvaluationId: null };

    // Policies never override a rule: re-check the rule outcome for this exact body here.
    const ruleEval = await d.ruleEvaluations.find(brand, row.id, sha, 'ingest');
    if (!ruleEval) {
      if (p.trigger === 'ingest') throw new JobError('retryable', 'rule_evaluation_pending');
      return {
        ...base,
        status: 'skipped',
        skipReason: 'rules_not_evaluated',
        ruleEvaluationId: null,
      };
    }
    if (ruleEval.status === 'skipped')
      return {
        ...base,
        status: 'skipped',
        skipReason: 'rules_not_evaluated',
        ruleEvaluationId: ruleEval.id,
      };
    // Any rule decision (including allow) stands.
    if (ruleEval.status !== 'no_match')
      return {
        ...base,
        status: 'skipped',
        skipReason: 'rule_decided',
        ruleEvaluationId: ruleEval.id,
      };

    // The policies that count are the ones current when the job runs, not when it was enqueued.
    let policies: ActivePolicy[];
    if (p.trigger === 'ingest') {
      // Sorted by (created_at, id); decidePolicies breaks ties by this order.
      policies = await d.policies.enabledForEvaluation(brand);
      if (policies.length === 0) return 'no_policies';
    } else {
      const one = await d.policies.forRun(brand, p.trigger.slice('run:'.length));
      if (!one)
        return {
          ...base,
          status: 'skipped',
          skipReason: 'policy_changed',
          ruleEvaluationId: ruleEval.id,
        };
      policies = [one];
    }
    const checkedRevisionIds = policies.map((x) => x.revisionId);
    const failed = (
      failureCode: FailureCode,
      usage: ModelUsage | null = null,
    ): EvaluationRecord => ({
      ...base,
      status: 'failed',
      failureCode,
      provider: d.evaluator.id,
      model: d.evaluator.model,
      ruleEvaluationId: ruleEval.id,
      checkedRevisionIds,
      usage,
    });

    const input = prepareInput(row.body);
    // A run must not undo a person's decision by hiding or deleting again.
    const moderatorActed =
      p.trigger !== 'ingest' && (await d.comments.latestActionActor(brand, row.id)) === 'user';
    const check = () =>
      runPolicyCheck(d.evaluator, input, policies, ctx.signal, { moderatorActed });
    let checked: Awaited<ReturnType<typeof check>>;
    if (input.empty) {
      checked = await check();
    } else {
      if (!d.evaluator.enabled) return failed('disabled');
      if (now() - p.requestedAt > d.maxWaitMs) return failed('queue_timeout');
      const lease = await d.slots.acquire(brand.brandId);
      if (!lease) throw new JobDeferral('policy_brand_busy', POLICY_BRAND_BUSY_RETRY_MS);
      try {
        if (!(await d.usage.consume(brand, d.monthlyCallsPerBrand)))
          return {
            ...base,
            status: 'skipped',
            skipReason: 'quota_exhausted',
            ruleEvaluationId: ruleEval.id,
          };
        checked = await check();
      } catch (e) {
        const err = mapProviderError(e);
        if (err.retryable && ctx.attempt < MAX_POLICY_PROVIDER_ATTEMPTS) {
          ctx.log.warn('policy.evaluation_retry', {
            commentId: row.id,
            code: err.code,
            attempt: ctx.attempt,
          });
          throw new JobError('retryable', `policy_${err.code}`);
        }
        ctx.log.warn('policy.evaluation_failed', {
          commentId: row.id,
          code: err.code,
          attempt: ctx.attempt,
        });
        return failed(err.code, err.usage);
      } finally {
        await lease
          .release()
          .catch(() => ctx.log.warn('policy.slot_release_failed', { commentId: row.id }));
      }
    }
    const { decision, provider, model, usage } = checked;
    return {
      ...base,
      status: 'evaluated',
      ruleEvaluationId: ruleEval.id,
      provider,
      model,
      promptVersion: POLICY_PROMPT_VERSION,
      checkedRevisionIds,
      inputTruncated: input.truncated,
      lowSignal: input.lowSignal,
      decision,
      reason: describeDecision(decision, { truncated: input.truncated }),
      usage,
    };
  }

  async function act(
    ctx: JobContext,
    brand: BrandScope,
    row: CommentRow,
    ev: EvaluationRow,
  ): Promise<JobResult> {
    const result = { result: ev.status, evaluationId: ev.id, outcome: ev.outcome };
    if (ev.status !== 'evaluated') return result;
    if (ev.outcome !== 'hide' && ev.outcome !== 'remove') return result;
    if (ev.fallbackAt) return { ...result, fallback: 'recorded' };
    if (ev.reviewMode) {
      const reason = await d.evaluations.decisionReason(brand, ev.id);
      if (reason === null) throw new Error('policy evaluation has no decision');
      const proposed = await d.suggestions.propose(ctx.scope, {
        commentId: row.id,
        source: { type: 'policy', ref: ev.id },
        steps: stepsForOutcome(ev.outcome),
        reason,
      });
      return 'skipped' in proposed
        ? { ...result, suggested: false, skipped: proposed.skipped }
        : { ...result, suggested: true };
    }
    const kind = ev.outcome === 'hide' ? 'hide' : 'delete';
    const r = await d.actions.request({
      scope: brand,
      commentId: row.id,
      kind,
      actor: { type: 'policy' },
      requestKey: `pol:${ev.id}`,
    });
    const code = actionFallbackCode(r);
    if (code) {
      await d.evaluations.recordFallback(brand, ev.id, code, describeFallback(kind, code));
      ctx.log.info('policy.fallback', { evaluationId: ev.id, code });
      return { ...result, fallback: code };
    }
    return { ...result, action: r.status };
  }

  return {
    ...POLICY_EVALUATE_JOB,
    handle: async (ctx, p) => {
      const brand = { organizationId: ctx.scope.organizationId, brandId: ctx.scope.brandId };
      const row = await d.comments.load(brand, p.commentId);
      if (!row || row.connectionId !== ctx.scope.connectionId) return { result: 'gone' };
      if (bodySha256(row.body) !== p.bodySha256) return { result: 'superseded' };
      const sha = Buffer.from(p.bodySha256, 'hex');
      let ev = await d.evaluations.find(brand, row.id, sha, p.trigger);
      if (!ev) {
        const rec = await evaluateOnce(ctx, p, row, sha, brand);
        if (rec === 'no_policies') return { result: 'no_policies' };
        const reviewMode = await d.reviewMode.isActive(ctx.scope);
        ev =
          (await d.evaluations.record(ctx.scope, {
            ...rec,
            reviewMode,
            retried: ctx.attempt > 1,
          })) ?? (await d.evaluations.find(brand, row.id, sha, p.trigger));
        if (!ev) throw new JobError('retryable', 'policy_evaluation_not_visible');
      }
      return act(ctx, brand, row, ev);
    },
  };
}
