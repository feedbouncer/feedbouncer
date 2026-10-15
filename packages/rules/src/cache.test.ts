import { describe, expect, it, vi } from 'vitest';
import type { RuleRecord } from './types.js';
import { RuleSetCache } from './cache.js';

const scope = (n: string) => ({ organizationId: 'o', brandId: n });
function fake() {
  const state = { version: 'v1' };
  const loadActive = vi.fn(async () => ({
    version: state.version,
    records: [] as RuleRecord[],
    ownDomains: [] as string[],
  }));
  const version = vi.fn(async () => state.version);
  return { state, loadActive, version };
}

describe('RuleSetCache', () => {
  it('compiles once per version', async () => {
    const s = fake();
    const cache = new RuleSetCache(s);
    const a = await cache.get(scope('b1'));
    const b = await cache.get(scope('b1'));
    expect(b).toBe(a);
    expect(s.loadActive).toHaveBeenCalledTimes(1);
    expect(a.version).toBe('v1');
  });

  it('recompiles when the version changes', async () => {
    const s = fake();
    const cache = new RuleSetCache(s);
    await cache.get(scope('b1'));
    s.state.version = 'v2';
    const b = await cache.get(scope('b1'));
    expect(b.version).toBe('v2');
    expect(s.loadActive).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used brand beyond maxBrands', async () => {
    const s = fake();
    const cache = new RuleSetCache(s, { maxBrands: 2 });
    await cache.get(scope('a'));
    await cache.get(scope('b'));
    await cache.get(scope('a')); // a is now most recent
    await cache.get(scope('c')); // evicts b
    expect(s.loadActive).toHaveBeenCalledTimes(3);
    await cache.get(scope('a'));
    expect(s.loadActive).toHaveBeenCalledTimes(3);
    await cache.get(scope('b'));
    expect(s.loadActive).toHaveBeenCalledTimes(4);
  });

  it('shares one compile between concurrent gets', async () => {
    const s = fake();
    const cache = new RuleSetCache(s);
    const [a, b, c] = await Promise.all([
      cache.get(scope('b1')),
      cache.get(scope('b1')),
      cache.get(scope('b1')),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(s.loadActive).toHaveBeenCalledTimes(1);
  });

  it('expires an entry after the ttl even if the version is unchanged', async () => {
    const s = fake();
    let now = 0;
    const cache = new RuleSetCache(s, { now: () => now });
    await cache.get(scope('b1'));
    now = 61_000;
    await cache.get(scope('b1'));
    expect(s.loadActive).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed load', async () => {
    const s = fake();
    s.loadActive.mockRejectedValueOnce(new Error('db'));
    const cache = new RuleSetCache(s);
    await expect(cache.get(scope('b1'))).rejects.toThrow('db');
    await expect(cache.get(scope('b1'))).resolves.toBeDefined();
  });
});
