import { mapProviderError, prepareInput, type PreparedInput } from '@feedbouncer/ai';
import {
  DisabledProvider,
  scoreClassification,
  type ClassifierProvider,
  type ThresholdPolicy,
} from '@feedbouncer/classifier';
import type { BrandSlots } from '@feedbouncer/db';
import {
  runPolicyCheck,
  type ActivePolicy,
  type PgPolicyUsage,
  type PolicyEvaluator,
} from '@feedbouncer/policies';
import { evaluate, type BrandScope, type CompiledRuleSet } from '@feedbouncer/rules';
import { combine, type ClassifierStage, type PolicyStage } from './combine.js';
import type { CheckResult } from './types.js';

export interface CheckDeps {
  rules: { get(scope: BrandScope): Promise<CompiledRuleSet> };
  thresholds: { policy(scope: BrandScope): Promise<ThresholdPolicy> };
  policies: { enabledForEvaluation(scope: BrandScope): Promise<ActivePolicy[]> };
  classifier: ClassifierProvider;
  policyEvaluator: PolicyEvaluator;
  languages: readonly string[];
  classifierTimeoutMs: number;
  policyTimeoutMs: number;
  /** The same per-brand limits the connected-platform policy job enforces. */
  policyBudget: {
    slots: Pick<BrandSlots, 'acquire'>;
    usage: Pick<PgPolicyUsage, 'consume'>;
    monthlyCallsPerBrand: number;
  };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAY_MS = 250;
const MIN_REMAINING_MS = 1000;

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };

/** Runs `call` with a signal that expires before the deadline; retries once on a retryable error. */
async function runStage<T>(
  d: CheckDeps,
  deadlineAt: number,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<Outcome<T>> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const budget = Math.min(timeoutMs, deadlineAt - now() - MIN_REMAINING_MS);
    if (budget <= 0) return { ok: false, code: 'timeout' };
    try {
      return { ok: true, value: await call(AbortSignal.timeout(budget)) };
    } catch (e) {
      const err = mapProviderError(e);
      if (
        attempt > 0 ||
        !err.retryable ||
        deadlineAt - now() <= RETRY_DELAY_MS + MIN_REMAINING_MS
      ) {
        return { ok: false, code: err.code };
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function classifierStage(
  d: CheckDeps,
  scope: BrandScope,
  input: PreparedInput,
  deadlineAt: number,
): Promise<ClassifierStage> {
  if (d.classifier instanceof DisabledProvider) return { kind: 'not_configured' };
  const thresholds = await d.thresholds.policy(scope);
  const out = await runStage(d, deadlineAt, d.classifierTimeoutMs, async (signal) => {
    const raw = await d.classifier.classify(input, signal);
    return { language: raw.language, ...scoreClassification(raw, input, thresholds, d.languages) };
  });
  if (!out.ok) return { kind: 'failed', code: out.code };
  return {
    kind: 'ok',
    verdict: out.value.verdict,
    language: out.value.language,
    provider: d.classifier.id,
    model: d.classifier.model,
  };
}

async function policyStage(
  d: CheckDeps,
  scope: BrandScope,
  input: PreparedInput,
  deadlineAt: number,
): Promise<PolicyStage> {
  if (!d.policyEvaluator.enabled) return { kind: 'skipped' };
  const policies = await d.policies.enabledForEvaluation(scope);
  if (policies.length === 0) return { kind: 'skipped' };
  const { slots, usage, monthlyCallsPerBrand } = d.policyBudget;
  const lease = await slots.acquire(scope.brandId);
  if (!lease) return { kind: 'failed', code: 'brand_busy' };
  let out: Outcome<Awaited<ReturnType<typeof runPolicyCheck>>>;
  try {
    if (!(await usage.consume(scope, monthlyCallsPerBrand))) {
      return { kind: 'failed', code: 'quota_exhausted' };
    }
    out = await runStage(d, deadlineAt, d.policyTimeoutMs, (signal) =>
      runPolicyCheck(d.policyEvaluator, input, policies, signal, {
        moderatorActed: async () => false,
      }),
    );
  } finally {
    await lease.release().catch(() => {});
  }
  if (!out.ok) return { kind: 'failed', code: out.code };
  const { decision, provider, model } = out.value;
  return { kind: 'ok', decision, provider, model };
}

const failed = (e: unknown) => ({ kind: 'failed' as const, code: mapProviderError(e).code });

/** `text` must already pass `validateCheckText`. */
export async function checkText(
  d: CheckDeps,
  scope: BrandScope,
  text: string,
  deadlineAt: number,
): Promise<CheckResult> {
  const input = prepareInput(text);
  if (input.truncated || input.empty) throw new RangeError('check text not validated');
  const { decided } = evaluate(await d.rules.get(scope), {
    body: text,
    platform: null,
    authorExternalId: null,
    authorName: null,
  });
  if (decided) return combine(decided, null, null);
  const [classifier, policy] = await Promise.all([
    classifierStage(d, scope, input, deadlineAt).catch(failed),
    policyStage(d, scope, input, deadlineAt).catch(failed),
  ]);
  return combine(null, classifier, policy);
}
