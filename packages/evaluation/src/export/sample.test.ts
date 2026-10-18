import { describe, expect, it } from 'vitest';
import { samplePermutation } from './sample.js';

describe('samplePermutation', () => {
  const xs = Array.from({ length: 50 }, (_, i) => i);

  it('is deterministic for a seed and a permutation', () => {
    const a = samplePermutation(xs, 42);
    expect(samplePermutation(xs, 42)).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(xs);
    expect(a).not.toEqual(xs);
    expect(samplePermutation(xs, 43)).not.toEqual(a);
  });

  it('does not mutate its input and handles empty input', () => {
    const copy = [...xs];
    samplePermutation(xs, 1);
    expect(xs).toEqual(copy);
    expect(samplePermutation([], 1)).toEqual([]);
  });
});
