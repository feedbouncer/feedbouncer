import type { ModelUsage, PreparedInput } from '@feedbouncer/ai';
import { decidePolicies } from './decide.js';
import type { PolicyEvaluator } from './evaluator.js';
import type { ActivePolicy, PolicyDecision, PolicyVerdict } from './types.js';

export interface PolicyAnswer {
  verdicts: ReadonlyMap<string, PolicyVerdict>;
  provider: string;
  model: string;
  usage: ModelUsage | null;
}

/** The model call alone. Throws whatever the evaluator throws; the caller maps it with `mapProviderError`. */
export async function askPolicies(
  evaluator: PolicyEvaluator,
  input: PreparedInput,
  policies: readonly ActivePolicy[],
  signal: AbortSignal,
): Promise<PolicyAnswer> {
  const keyed = policies.map((x, i) => ({ key: `p${i + 1}`, text: x.text }));
  const keys = keyed.map((k) => k.key);
  let byKey: Readonly<Record<string, PolicyVerdict>>;
  let provider = evaluator.id;
  let model = evaluator.model;
  let usage: ModelUsage | null = null;
  if (input.empty) {
    byKey = Object.fromEntries(keys.map((k) => [k, 'no_match' as const]));
    provider = 'builtin';
    model = 'empty-input';
  } else {
    ({ verdicts: byKey, usage } = await evaluator.evaluate(input, keyed, signal));
  }
  const verdicts = new Map(policies.map((x, i) => [x.revisionId, byKey[keys[i]!]!]));
  return { verdicts, provider, model, usage };
}

export function decideAnswer(
  policies: readonly ActivePolicy[],
  answer: PolicyAnswer,
  input: PreparedInput,
  moderatorActed: boolean,
): PolicyDecision {
  return decidePolicies(policies, answer.verdicts, { lowSignal: input.lowSignal, moderatorActed });
}

export async function runPolicyCheck(
  evaluator: PolicyEvaluator,
  input: PreparedInput,
  policies: readonly ActivePolicy[],
  signal: AbortSignal,
  /** Called after the evaluator answers, so an action taken during the call still counts. */
  o: { moderatorActed: () => Promise<boolean> },
): Promise<{
  decision: PolicyDecision;
  provider: string;
  model: string;
  usage: ModelUsage | null;
}> {
  const answer = await askPolicies(evaluator, input, policies, signal);
  const decision = decideAnswer(policies, answer, input, await o.moderatorActed());
  return { decision, provider: answer.provider, model: answer.model, usage: answer.usage };
}
