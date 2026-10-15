import { describe, expect, it, vi } from 'vitest';
import { CompositeActionOutcomeObserver } from './hooks.js';

const e = { requestKey: 'clf:x' } as never;

describe('CompositeActionOutcomeObserver', () => {
  it('calls every observer even if one throws, then rethrows the first error', async () => {
    const a = { onActionOutcome: vi.fn().mockRejectedValue(new Error('a')) };
    const b = { onActionOutcome: vi.fn().mockResolvedValue(undefined) };
    await expect(new CompositeActionOutcomeObserver([a, b]).onActionOutcome(e)).rejects.toThrow(
      'a',
    );
    expect(b.onActionOutcome).toHaveBeenCalledWith(e);
  });
  it('resolves when all succeed', async () => {
    const a = { onActionOutcome: vi.fn().mockResolvedValue(undefined) };
    await expect(
      new CompositeActionOutcomeObserver([a]).onActionOutcome(e),
    ).resolves.toBeUndefined();
  });
  it('still calls later observers when one throws synchronously', async () => {
    const a = {
      onActionOutcome: vi.fn(() => {
        throw new Error('sync');
      }),
    };
    const b = { onActionOutcome: vi.fn().mockResolvedValue(undefined) };
    await expect(new CompositeActionOutcomeObserver([a, b]).onActionOutcome(e)).rejects.toThrow(
      'sync',
    );
    expect(b.onActionOutcome).toHaveBeenCalledWith(e);
  });
});
