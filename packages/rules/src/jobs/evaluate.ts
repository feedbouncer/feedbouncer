// Evaluates one stored comment body against its brand's rules, records the
// evaluation and decisions, and starts the action run of the enforcing rule
// (dry runs for the suggest-mode matches). Repeating it is safe: the evaluation
// is unique per (comment, body version, trigger) and a run is unique per
// (evaluation, rule). A run that finds an existing evaluation resumes at the
// action step.
// Logs carry ids, kinds and error names only: never comment text, author
// names or rule terms.
import {
  splitGated,
  type ActionRunner,
  type ActionStep,
  type PgSuggestionStore,
} from '@feedbouncer/actions';
import type { BrandScope, PgCommentStore, PgReviewModeReader } from '@feedbouncer/comments';
import type { JobDefinition, JobResult } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { RuleSetCache } from '../cache.js';
import { evaluate } from '../engine.js';
import type { EvaluationRow, PgEvaluationStore } from '../evaluations.js';
import type { RuleEvaluatedHook } from '../hooks.js';
import type { Verdict } from '../types.js';
import { RULE_EVALUATE_JOB, bodySha256, type RuleEvaluatePayload } from './specs.js';

/** ruleset_version of an evaluation that never loaded the rules (skipped comments). */
const NO_RULESET = '-';

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'NonError');

export function ruleEvaluateJob(d: {
  comments: PgCommentStore;
  evaluations: PgEvaluationStore;
  cache: RuleSetCache;
  runner: Pick<ActionRunner, 'start'>;
  suggestions: Pick<PgSuggestionStore, 'propose'>;
  reviewMode: Pick<PgReviewModeReader, 'isActive'>;
  log: Logger;
  clock?: { now(): number };
  evaluated?: RuleEvaluatedHook;
}): JobDefinition<RuleEvaluatePayload> {
  return {
    ...RULE_EVALUATE_JOB,
    handle: async (ctx, p) => {
      const brand: BrandScope = {
        organizationId: ctx.scope.organizationId,
        brandId: ctx.scope.brandId,
      };
      const sha = Buffer.from(p.bodySha256, 'hex');

      // Tenancy guard: the payload id only reaches comments of this job's connection.
      const row = await d.comments.load(brand, p.commentId);
      if (!row || row.connectionId !== ctx.scope.connectionId) return { result: 'gone' };
      if (bodySha256(row.body) !== p.bodySha256) return { result: 'superseded' };

      let ev = await d.evaluations.find(brand, p.commentId, sha, p.trigger);
      let verdict: Verdict | undefined;
      if (!ev) {
        const base = { commentId: p.commentId, sha, triggerKey: p.trigger };
        const skipReason =
          row.platformState === 'deleted' ? 'deleted' : row.isOwnAccount ? 'own_account' : null;
        if (skipReason !== null) {
          await d.evaluations.record(ctx.scope, {
            ...base,
            rulesetVersion: NO_RULESET,
            status: 'skipped',
            skipReason,
          });
          return { result: 'skipped', reason: skipReason };
        }
        const reviewMode = await d.reviewMode.isActive(ctx.scope);
        const set = await d.cache.get(brand);
        const clock = d.clock;
        for (const inv of set.invalid)
          d.log.warn('rule_conditions_invalid', { ruleId: inv.ruleId });
        verdict = evaluate(
          set,
          {
            body: row.body,
            platform: row.platform,
            authorExternalId: row.authorExternalId,
            authorName: row.authorName,
            origin: row.origin,
          },
          {
            ...(clock ? { now: () => clock.now() } : {}),
            collectAlsoMatched: reviewMode,
            onRuleError: (ruleId, err) =>
              d.log.warn('rule_evaluation_error', {
                ruleId,
                commentId: p.commentId,
                errorName: errorName(err),
              }),
          },
        );
        for (const t of verdict.trace)
          if (t.skipReason === 'timeout')
            d.log.warn('rule_evaluation_timeout', { ruleId: t.ruleId, commentId: p.commentId });
        ev =
          (await d.evaluations.record(ctx.scope, {
            ...base,
            rulesetVersion: set.version,
            status: verdict.decided ? 'decided' : 'no_match',
            verdict,
            reviewMode,
          })) ??
          // Lost a race with another run of the same key: resume from its row.
          (await d.evaluations.find(brand, p.commentId, sha, p.trigger));
        if (!ev) throw new Error('rule evaluation was neither recorded nor found');
      }
      const res = await act(d, ctx.scope, ev, p.commentId, verdict);
      // After act(): a throw here retries the job; record and act are idempotent
      // (a run is unique per evaluation and rule, and the runner's auto: keys
      // deduplicate platform calls), so the rule action is never delayed.
      if (d.evaluated && (ev.status === 'no_match' || ev.status === 'decided'))
        await d.evaluated.onEvaluated({
          scope: ctx.scope,
          platform: row.platform,
          commentId: p.commentId,
          bodySha256: p.bodySha256,
          evaluationId: ev.id,
          status: ev.status,
        });
      return res;
    },
  };
}

async function act(
  d: Pick<Parameters<typeof ruleEvaluateJob>[0], 'runner' | 'suggestions' | 'evaluations' | 'log'>,
  scope: ConnectionScope,
  ev: EvaluationRow,
  commentId: string,
  verdict: Verdict | undefined,
): Promise<JobResult> {
  const base = { result: ev.status, evaluationId: ev.id, outcome: ev.outcome };
  const start = (ruleId: string, steps: ActionStep[], dryRun: boolean) =>
    d.runner.start(scope, { commentId, ruleId, evaluationId: ev.id, dryRun, steps });
  // Only a freshly recorded evaluation has simulations to run: they are not needed to resume.
  for (const s of verdict?.suggestions ?? []) await start(s.ruleId, s.actions, true);
  if (ev.status !== 'decided' || ev.matchedRuleId === null) return base;
  // Already fell back: the user was told it is flagged; do not start the actions now.
  if (ev.fallbackAt !== null) return { ...base, fallback: 'recorded' };
  const { flag, gated } = ev.reviewMode
    ? splitGated(ev.matchedActions)
    : { flag: ev.matchedActions, gated: [] };
  let runId: string | undefined;
  if (flag.length > 0) runId = (await start(ev.matchedRuleId, flag, false)).id;
  if (gated.length > 0) {
    const reason = await d.evaluations.decisionReason(scope, ev.id);
    if (reason === null) throw new Error('decided evaluation has no decision');
    const proposed = await d.suggestions.propose(scope, {
      commentId,
      source: {
        type: 'rule',
        ref: ev.id,
        ruleId: ev.matchedRuleId,
        alsoMatchedRuleIds: ev.alsoMatchedRuleIds,
      },
      steps: gated,
      reason,
    });
    if ('skipped' in proposed)
      d.log.info('suggestion_skipped', { evaluationId: ev.id, skipped: proposed.skipped });
  }
  return runId ? { ...base, runId } : base;
}
