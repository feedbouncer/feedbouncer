// Evaluates one stored comment body against its brand's rules, records the
// evaluation and decisions, and asks for the platform action an enforcing
// hide/remove rule wants. Repeating it is safe: the evaluation is unique per
// (comment, body version, trigger), the action is deduplicated by its request
// key and the fallback flag is written at most once. A run that finds an
// existing evaluation resumes at the action step.
// Logs carry ids, kinds and error names only: never comment text, author
// names or rule terms.
import type { BrandScope, ModerationActions, PgCommentStore } from '@feedbouncer/comments';
import type { JobDefinition, JobResult } from '@feedbouncer/jobs';
import type { Platform } from '@feedbouncer/connectors';
import type { Logger } from '@feedbouncer/service-runtime';
import type { RuleSetCache } from '../cache.js';
import { evaluate } from '../engine.js';
import type { EvaluationRow, PgEvaluationStore } from '../evaluations.js';
import { describeFallback } from '../reason.js';
import { RULE_EVALUATE_JOB, bodySha256, type RuleEvaluatePayload } from './specs.js';

/** ruleset_version of an evaluation that never loaded the rules (skipped comments). */
const NO_RULESET = '-';

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'NonError');

export function ruleEvaluateJob(d: {
  comments: PgCommentStore;
  evaluations: PgEvaluationStore;
  cache: RuleSetCache;
  actions: Pick<ModerationActions, 'request'>;
  log: Logger;
  clock?: { now(): number };
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
        const set = await d.cache.get(brand);
        const clock = d.clock;
        for (const inv of set.invalid)
          d.log.warn('rule_conditions_invalid', { ruleId: inv.ruleId });
        const verdict = evaluate(
          set,
          {
            body: row.body,
            platform: row.platform,
            authorExternalId: row.authorExternalId,
            authorName: row.authorName,
          },
          {
            ...(clock ? { now: () => clock.now() } : {}),
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
          })) ??
          // Lost a race with another run of the same key: resume from its row.
          (await d.evaluations.find(brand, p.commentId, sha, p.trigger));
        if (!ev) throw new Error('rule evaluation was neither recorded nor found');
      }
      return act(d, brand, ev, p.commentId, row.platform);
    },
  };
}

async function act(
  d: Pick<Parameters<typeof ruleEvaluateJob>[0], 'actions' | 'evaluations' | 'log'>,
  brand: BrandScope,
  ev: EvaluationRow,
  commentId: string,
  platform: Platform,
): Promise<JobResult> {
  const base = { result: ev.status, evaluationId: ev.id, outcome: ev.outcome };
  const outcome = ev.outcome;
  // approve and flag need no platform call: the decision row is the record.
  if (ev.status !== 'decided' || (outcome !== 'hide' && outcome !== 'remove')) return base;
  // Already fell back: the user was told it is flagged; do not start the action now.
  if (ev.fallbackAt !== null) return { ...base, fallback: 'recorded' };
  const r = await d.actions.request({
    scope: brand,
    commentId,
    kind: outcome === 'hide' ? 'hide' : 'delete',
    actor: { type: 'rule', ruleId: ev.matchedRuleId! },
    requestKey: `rule-eval:${ev.id}`,
  });
  let failedCode: string | null = null;
  if (r.status === 'refused') failedCode = r.code;
  else if (
    r.status === 'recorded' &&
    (r.action.status === 'not_eligible' || r.action.status === 'failed')
  )
    failedCode = r.action.outcomeCode ?? 'failed';
  else return { ...base, action: r.action.status };
  const info = await d.evaluations.loadForFallback(brand, ev.id);
  if (info)
    await d.evaluations.recordFallback(
      brand,
      ev.id,
      failedCode,
      describeFallback(info.ruleName, outcome, failedCode, platform),
    );
  d.log.info('rule_action_fallback', { evaluationId: ev.id, commentId, code: failedCode });
  return { ...base, fallback: failedCode };
}
