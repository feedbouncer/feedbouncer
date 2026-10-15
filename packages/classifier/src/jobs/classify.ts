// comment_classify: scores one stored comment body, applies the brand's
// thresholds when no rule decided, and asks for the resulting platform action.
// Repeating it is safe: the classification is unique per (comment, body
// version, trigger), the action is deduplicated by its request key and the
// fallback / reversal flags are written once.
// Logs carry ids and closed codes only: never comment text or model output.
import {
  JobDeferral,
  JobError,
  type JobContext,
  type JobDefinition,
  type JobResult,
} from '@feedbouncer/jobs';
import type { CommentRow, ModerationActions, PgCommentStore } from '@feedbouncer/comments';
import { bodySha256, type BrandScope, type PgEvaluationStore } from '@feedbouncer/rules';
import type { Logger } from '@feedbouncer/service-runtime';
import { ZERO_SCORES } from '../defaults.js';
import { describeClassification, describeFallback, describeReversal } from '../describe.js';
import { mapProviderError, PROMPT_VERSION } from '../llm-provider.js';
import { decide, roundScores } from '../policy.js';
import { prepareInput } from '../prepare.js';
import type { ClassifierProvider, RawClassification } from '../provider.js';
import type { BrandSlots } from '../slots.js';
import type { ClassificationRecord, ClassificationRow, PgClassificationStore } from '../store.js';
import type { PgThresholdStore } from '../thresholds-store.js';
import { CLASSIFY_JOB, MAX_PROVIDER_ATTEMPTS, type ClassifyPayload } from './specs.js';

export interface ClassifyDeps {
  comments: Pick<PgCommentStore, 'load'>;
  ruleEvaluations: Pick<PgEvaluationStore, 'find'>;
  classifications: PgClassificationStore;
  thresholds: Pick<PgThresholdStore, 'policy'>;
  provider: ClassifierProvider;
  slots: Pick<BrandSlots, 'acquire'>;
  actions: Pick<ModerationActions, 'request'>;
  languages: readonly string[];
  maxWaitMs: number;
  log: Logger;
  clock?: { now(): number };
}

const SAFE_CODE = /^[a-z][a-z_]{0,63}$/;
type RequestResult = Awaited<ReturnType<ModerationActions['request']>>;

/** Null when the action went through (or is pending); otherwise a closed snake_case code. */
function fallbackCode(r: RequestResult): string | null {
  if (r.status === 'refused') return SAFE_CODE.test(r.code) ? r.code : 'refused';
  if (
    r.status === 'recorded' &&
    (r.action.status === 'not_eligible' || r.action.status === 'failed')
  ) {
    const code = r.action.outcomeCode ?? r.action.status;
    return SAFE_CODE.test(code) ? code : r.action.status;
  }
  return null;
}

export function classifyCommentJob(d: ClassifyDeps): JobDefinition<ClassifyPayload> {
  const now = () => d.clock?.now() ?? Date.now();

  async function classifyOnce(
    ctx: JobContext,
    p: ClassifyPayload,
    row: CommentRow,
    sha: Buffer,
    brand: BrandScope,
  ): Promise<ClassificationRecord> {
    const base = { commentId: row.id, sha, triggerKey: p.trigger };
    if (row.platformState === 'deleted')
      return { ...base, status: 'skipped', skipReason: 'deleted', inputChars: row.body.length };
    if (row.isOwnAccount)
      return { ...base, status: 'skipped', skipReason: 'own_account', inputChars: row.body.length };

    const ruleEval = await d.ruleEvaluations.find(brand, row.id, sha, 'ingest');
    if (!ruleEval || ruleEval.status === 'skipped') {
      if (!ruleEval && p.trigger === 'ingest')
        throw new JobError('retryable', 'rule_evaluation_pending');
      return {
        ...base,
        status: 'skipped',
        skipReason: 'rules_not_evaluated',
        inputChars: row.body.length,
      };
    }

    const input = prepareInput(row.body);
    let raw: RawClassification;
    let provider = d.provider.id;
    let model = d.provider.model;
    let scoresReused = false;
    if (input.empty) {
      raw = { scores: ZERO_SCORES, language: 'und' };
      provider = 'builtin';
      model = 'empty-input';
    } else {
      const prior = await d.classifications.findReusableScores(
        brand,
        row.id,
        sha,
        provider,
        model,
        PROMPT_VERSION,
      );
      if (prior) {
        raw = prior;
        scoresReused = true;
      } else {
        if (now() - p.requestedAt > d.maxWaitMs)
          return { ...base, status: 'unclassified', unclassifiedReason: 'queue_timeout', input };
        const lease = await d.slots.acquire(brand.brandId);
        if (!lease) throw new JobDeferral('classifier_brand_busy', null);
        try {
          raw = await d.provider.classify(input, ctx.signal);
        } catch (e) {
          const err = mapProviderError(e);
          if (err.retryable && ctx.attempt < MAX_PROVIDER_ATTEMPTS)
            throw new JobError('retryable', `classifier_${err.code}`);
          ctx.log.warn('classifier.unclassified', {
            commentId: row.id,
            code: err.code,
            attempt: ctx.attempt,
          });
          return { ...base, status: 'unclassified', unclassifiedReason: err.code, input };
        } finally {
          await lease.release();
        }
      }
    }

    const scores = roundScores(raw.scores);
    const languageSupported = input.empty || d.languages.includes(raw.language);
    const policy = await d.thresholds.policy(brand);
    const verdict = decide(scores, policy, { lowSignal: input.lowSignal, languageSupported });
    return {
      ...base,
      status: 'classified',
      provider,
      model,
      promptVersion: PROMPT_VERSION,
      scores,
      language: raw.language,
      languageSupported,
      input,
      scoresReused,
      ruleEvaluationId: ruleEval.id,
      ruleDecided: ruleEval.status === 'decided',
      policy,
      verdict,
      reason: describeClassification(verdict, { truncated: input.truncated }),
    };
  }

  async function act(
    ctx: JobContext,
    brand: BrandScope,
    row: CommentRow,
    c: ClassificationRow,
  ): Promise<JobResult> {
    const result = { result: c.status, classificationId: c.id, outcome: c.outcome };
    if (c.status !== 'classified' || c.ruleDecided) return result;
    if (c.fallbackAt) return { ...result, fallback: 'recorded' };

    if (c.outcome === 'hide' || c.outcome === 'remove') {
      const kind = c.outcome === 'hide' ? 'hide' : 'delete';
      const r = await d.actions.request({
        scope: brand,
        commentId: row.id,
        kind,
        actor: { type: 'classifier' },
        requestKey: `clf:${c.id}`,
      });
      const code = fallbackCode(r);
      if (code) {
        await d.classifications.recordFallback(brand, c.id, code, describeFallback(kind, code));
        ctx.log.info('classifier.fallback', { classificationId: c.id, code });
        return { ...result, fallback: code };
      }
      return { ...result, action: r.status };
    }

    // Not destructive now: undo an earlier hide the classifier itself made (edit or explicit re-run).
    if (row.platformState !== 'hidden') return result;
    const prev = await d.classifications.reversibleClassifierHide(brand, row.id);
    if (!prev || prev.classificationId === c.id || !c.scores) return result;
    const score = c.scores[prev.category];
    if (score >= prev.threshold) return result;
    await d.classifications.recordReversal(
      brand,
      c.id,
      prev.category,
      score,
      prev.threshold,
      describeReversal(prev.category, score, prev.threshold),
    );
    const r = await d.actions.request({
      scope: brand,
      commentId: row.id,
      kind: 'unhide',
      actor: { type: 'classifier' },
      requestKey: `clf:${c.id}:unhide`,
    });
    const code = fallbackCode(r);
    if (code) {
      await d.classifications.recordFallback(brand, c.id, code, describeFallback('unhide', code), {
        category: prev.category,
        score,
        threshold: prev.threshold,
      });
      return { ...result, fallback: code };
    }
    return { ...result, action: r.status, reversed: true };
  }

  return {
    ...CLASSIFY_JOB,
    handle: async (ctx, p) => {
      const brand = { organizationId: ctx.scope.organizationId, brandId: ctx.scope.brandId };
      const row = await d.comments.load(brand, p.commentId);
      if (!row || row.connectionId !== ctx.scope.connectionId) return { result: 'gone' };
      if (bodySha256(row.body) !== p.bodySha256) return { result: 'superseded' };
      const sha = Buffer.from(p.bodySha256, 'hex');
      let c = await d.classifications.find(brand, row.id, sha, p.trigger);
      if (!c) {
        const rec = await classifyOnce(ctx, p, row, sha, brand);
        c =
          (await d.classifications.record(ctx.scope, rec)) ??
          (await d.classifications.find(brand, row.id, sha, p.trigger));
        if (!c) throw new JobError('retryable', 'classification_not_visible');
      }
      return act(ctx, brand, row, c);
    },
  };
}
