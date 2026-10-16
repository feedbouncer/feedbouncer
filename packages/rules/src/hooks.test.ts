import { describe, expect, it, vi } from 'vitest';
import { CompositeRuleEvaluatedHook, type RuleEvaluatedEvent } from './hooks.js';

const e = { commentId: 'c', status: 'no_match' } as unknown as RuleEvaluatedEvent;

describe('CompositeRuleEvaluatedHook', () => {
  it('calls every hook even when one fails, then rethrows', async () => {
    const a = { onEvaluated: vi.fn().mockRejectedValue(new Error('a')) };
    const b = { onEvaluated: vi.fn().mockResolvedValue(undefined) };
    await expect(new CompositeRuleEvaluatedHook([a, b]).onEvaluated(e)).rejects.toThrow('a');
    expect(b.onEvaluated).toHaveBeenCalledWith(e);
  });
  it('wraps several failures in an AggregateError', async () => {
    const f = { onEvaluated: vi.fn().mockRejectedValue(new Error('x')) };
    await expect(new CompositeRuleEvaluatedHook([f, f]).onEvaluated(e)).rejects.toBeInstanceOf(
      AggregateError,
    );
  });
  it('resolves when all succeed', async () => {
    const ok = { onEvaluated: vi.fn().mockResolvedValue(undefined) };
    await expect(new CompositeRuleEvaluatedHook([ok, ok]).onEvaluated(e)).resolves.toBeUndefined();
    expect(ok.onEvaluated).toHaveBeenCalledTimes(2);
  });
});
