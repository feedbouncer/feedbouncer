import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JobRegistry, type JobDefinition } from './definition.js';

const def = (over: Partial<JobDefinition<{ id: string }>> = {}): JobDefinition<{ id: string }> => ({
  type: 'hide_comment',
  platforms: ['facebook'],
  payload: z.strictObject({ id: z.string() }),
  externalRef: (p) => `${p.id}:hide`,
  handle: async () => ({ status: 'ok' }),
  ...over,
});

describe('JobRegistry', () => {
  it('registers and looks up by type and platform', () => {
    const r = new JobRegistry();
    r.register(def());
    expect(r.get('hide_comment')?.type).toBe('hide_comment');
    expect(r.supports('hide_comment', 'facebook')).toBe(true);
    expect(r.supports('hide_comment', 'youtube')).toBe(false);
    r.register(def({ type: 'any_platform', platforms: 'all' }));
    expect(r.supports('any_platform', 'bluesky')).toBe(true);
  });
  it.each([
    [{ type: 'Bad-Type' }, 'type'],
    [{ platforms: ['myspace' as never] }, 'platforms'],
    [{ platforms: [] }, 'platforms'],
    [{ timeoutMs: 999 }, 'timeoutMs'],
    [{ timeoutMs: 600_001 }, 'timeoutMs'],
    [{ policy: { maxAttempts: 0 } }, 'policy'],
  ])('rejects %o', (over, field) => {
    expect(() => new JobRegistry().register(def(over))).toThrow(`Invalid job definition: ${field}`);
  });
  it('rejects duplicates', () => {
    const r = new JobRegistry();
    r.register(def());
    expect(() => r.register(def())).toThrow('already registered');
  });
  it('accepts a valid lane and rejects an invalid one; exposes laneOf and lanes', () => {
    const r = new JobRegistry();
    r.register(def({ type: 'lane_job', lane: 'classify' }));
    r.register(def({ type: 'plain_job' }));
    expect(r.laneOf()('lane_job')).toBe('classify');
    expect(r.laneOf()('plain_job')).toBeNull();
    expect(r.lanes()).toEqual(['classify']);
    expect(() => r.register(def({ type: 'bad_lane', lane: 'NO' }))).toThrow(/lane/);
  });
});
