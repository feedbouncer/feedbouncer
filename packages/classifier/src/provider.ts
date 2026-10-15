import { z } from 'zod';
import type { CategoryScores, PreparedInput } from './types.js';

export type ProviderErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'invalid_output'
  | 'bad_request'
  | 'disabled';

/** Closed codes only; a foreign error's message is never copied (it can echo request data). */
export class ClassifierProviderError extends Error {
  override name = 'ClassifierProviderError';
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryable: boolean,
  ) {
    super(`classifier provider error: ${code}`);
  }
}

const score = z.number().min(0).max(1).refine(Number.isFinite);
export const rawClassificationSchema = z.strictObject({
  scores: z.strictObject({
    spam: score,
    scam_phishing: score,
    harassment_abuse: score,
    hate_speech: score,
    sexual_content: score,
    profanity: score,
    self_promotion: score,
  }),
  language: z
    .string()
    .max(8)
    .transform((s) => s.toLowerCase())
    .pipe(z.string().regex(/^(?:[a-z]{2,3}|und)$/)),
});
export interface RawClassification {
  scores: CategoryScores;
  language: string;
}

export interface ClassifierProvider {
  /** Stored in decision.classifier_provider. */
  readonly id: string;
  /** Stored in decision.classifier_model. */
  readonly model: string;
  classify(input: PreparedInput, signal: AbortSignal): Promise<RawClassification>;
}

export class DisabledProvider implements ClassifierProvider {
  readonly id = 'none';
  readonly model = 'none';
  readonly classify: ClassifierProvider['classify'] = async () => {
    throw new ClassifierProviderError('disabled', false);
  };
}
