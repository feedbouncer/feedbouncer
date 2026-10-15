import {
  AI_PROVIDERS,
  createLanguageModel,
  loadModelConfig,
  type ModelConfig,
} from '@feedbouncer/ai';
import { readEnum, readInt, type Env } from '@feedbouncer/service-runtime';
import { DisabledPolicyEvaluator, LlmPolicyEvaluator, type PolicyEvaluator } from './evaluator.js';

export const POLICY_FILE_VARS = ['POLICY_API_KEY'] as const;

export interface PolicyConfig {
  readonly model: ModelConfig | null;
  readonly timeoutMs: number;
  readonly perBrandInFlight: number;
  readonly maxWaitMs: number;
  readonly monthlyCallsPerBrand: number;
}

const set = (env: Env, k: string) => (env[k] ?? '') !== '';
/** POLICY_PROVIDER unset → reuse the classifier's model; POLICY_PROVIDER=none → disabled. */
const prefix = (env: Env) => (set(env, 'POLICY_PROVIDER') ? 'POLICY' : 'CLASSIFIER');

const monthly = (env: Env) =>
  readInt(env, 'POLICY_MONTHLY_CALLS_PER_BRAND', { min: 0, max: 10_000_000, fallback: 20_000 });

export function loadPolicyConfig(env: Env): PolicyConfig {
  return {
    model: loadModelConfig(env, prefix(env)),
    timeoutMs: readInt(env, 'POLICY_TIMEOUT_MS', { min: 1_000, max: 25_000, fallback: 15_000 }),
    perBrandInFlight: readInt(env, 'POLICY_BRAND_MAX_IN_FLIGHT', { min: 1, max: 16, fallback: 2 }),
    maxWaitMs: readInt(env, 'POLICY_MAX_WAIT_MINUTES', { min: 1, max: 240, fallback: 60 }) * 60_000,
    monthlyCallsPerBrand: monthly(env),
  };
}

/** For the API process, which never holds the provider key. */
export function loadPolicyLimits(env: Env): {
  monthlyCallsPerBrand: number;
  evaluatorConfigured: boolean;
} {
  const p = readEnum(env, `${prefix(env)}_PROVIDER`, [...AI_PROVIDERS, 'none'] as const, 'none');
  return { monthlyCallsPerBrand: monthly(env), evaluatorConfigured: p !== 'none' };
}

export function createPolicyEvaluator(c: PolicyConfig): PolicyEvaluator {
  if (!c.model) return new DisabledPolicyEvaluator();
  return new LlmPolicyEvaluator({
    model: createLanguageModel(c.model),
    providerId: c.model.provider,
    modelId: c.model.model,
    timeoutMs: c.timeoutMs,
  });
}
