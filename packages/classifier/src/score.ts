import type { PreparedInput } from '@feedbouncer/ai';
import { decide, roundScores } from './policy.js';
import type { RawClassification } from './provider.js';
import type { CategoryScores, ClassifierVerdict, ThresholdPolicy } from './types.js';

export function scoreClassification(
  raw: RawClassification,
  input: PreparedInput,
  policy: ThresholdPolicy,
  languages: readonly string[],
): { scores: CategoryScores; languageSupported: boolean; verdict: ClassifierVerdict } {
  const scores = roundScores(raw.scores);
  const languageSupported = input.empty || languages.includes(raw.language);
  const verdict = decide(scores, policy, { lowSignal: input.lowSignal, languageSupported });
  return { scores, languageSupported, verdict };
}
