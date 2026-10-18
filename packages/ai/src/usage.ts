import type { LanguageModelUsage } from 'ai';

/** Token counts as reported by the provider; null where it did not report one. */
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
}

export const UNKNOWN_USAGE: ModelUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
};

const count = (n: number | undefined): number | null =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;

export function toModelUsage(u: LanguageModelUsage | undefined): ModelUsage {
  if (!u) return { ...UNKNOWN_USAGE };
  return {
    inputTokens: count(u.inputTokens),
    outputTokens: count(u.outputTokens),
    cacheReadTokens: count(u.inputTokenDetails?.cacheReadTokens),
  };
}
