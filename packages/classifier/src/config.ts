import {
  AI_PROVIDERS,
  MODEL_ID,
  createLanguageModel,
  loadModelConfig,
  type ModelConfig,
} from '@feedbouncer/ai';
import {
  EnvError,
  readEnum,
  readInt,
  readRequiredString,
  readString,
  type Env,
} from '@feedbouncer/service-runtime';
import { MAX_CONFIGURABLE_WAIT_MS } from './jobs/specs.js';
import { LlmClassifierProvider } from './llm-provider.js';
import { DisabledProvider, type ClassifierProvider } from './provider.js';

/** Settings that may be supplied as <NAME>_FILE (mounted secret files). */
export const CLASSIFIER_FILE_VARS = ['CLASSIFIER_API_KEY'] as const;
const LANG = /^[a-z]{2,3}$/;
const MINUTE_MS = 60_000;

export interface ClassifierConfig {
  /** Null when no provider is configured: classification is disabled. */
  readonly model: ModelConfig | null;
  readonly timeoutMs: number;
  readonly languages: readonly string[];
  readonly perBrandInFlight: number;
  readonly maxWaitMs: number;
}

export function loadClassifierConfig(env: Env): ClassifierConfig {
  const languages = readString(env, 'CLASSIFIER_LANGUAGES', {
    fallback: 'en,es,pt,fr,de,it,nl',
    maxLength: 400,
  })
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (languages.length === 0 || !languages.every((l) => LANG.test(l))) {
    throw new EnvError(
      'CLASSIFIER_LANGUAGES must be a comma-separated list of lower-case ISO 639-1/639-2 codes',
    );
  }
  return {
    model: loadModelConfig(env, 'CLASSIFIER'),
    timeoutMs: readInt(env, 'CLASSIFIER_TIMEOUT_MS', { min: 1_000, max: 25_000, fallback: 10_000 }),
    languages,
    perBrandInFlight: readInt(env, 'CLASSIFIER_BRAND_MAX_IN_FLIGHT', {
      min: 1,
      max: 16,
      fallback: 2,
    }),
    maxWaitMs:
      readInt(env, 'CLASSIFIER_MAX_WAIT_MINUTES', {
        min: 1,
        max: MAX_CONFIGURABLE_WAIT_MS / MINUTE_MS,
        fallback: 30,
      }) * MINUTE_MS,
  };
}

/**
 * Provider and model for display, validated like loadClassifierConfig but never
 * reading the key, so processes that only show the setting need not hold it.
 */
export function describeClassifierProvider(env: Env): {
  id: string;
  model: string;
  enabled: boolean;
} {
  const id = readEnum(env, 'CLASSIFIER_PROVIDER', [...AI_PROVIDERS, 'none'] as const, 'none');
  if (id === 'none') return { id, model: '', enabled: false };
  const model = readRequiredString(env, 'CLASSIFIER_MODEL', { maxLength: 200, pattern: MODEL_ID });
  return { id, model, enabled: true };
}

export function createClassifierProvider(c: ClassifierConfig): ClassifierProvider {
  if (c.model === null) return new DisabledProvider();
  return new LlmClassifierProvider({
    model: createLanguageModel(c.model),
    providerId: c.model.provider,
    modelId: c.model.model,
    timeoutMs: c.timeoutMs,
  });
}
