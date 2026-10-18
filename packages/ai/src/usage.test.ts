import { describe, expect, it } from 'vitest';
import { toModelUsage, UNKNOWN_USAGE } from './usage.js';

describe('toModelUsage', () => {
  it('maps v7 fields', () => {
    expect(
      toModelUsage({
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 100 },
      } as never),
    ).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 });
  });
  it('is all null when usage is missing', () => {
    expect(toModelUsage(undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    });
    expect(UNKNOWN_USAGE).toEqual(toModelUsage(undefined));
  });
  it('nulls values that are not non-negative safe integers', () => {
    expect(toModelUsage({ inputTokens: -1, outputTokens: 1.5 } as never)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    });
    expect(
      toModelUsage({ inputTokens: Number.MAX_SAFE_INTEGER + 1 } as never).inputTokens,
    ).toBeNull();
  });
});
