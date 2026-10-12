import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JobRegistry } from './definition.js';
import { assertDedupWindow, loadJobsConfig } from './config.js';

describe('loadJobsConfig', () => {
  it('has documented defaults', () => {
    const c = loadJobsConfig({});
    expect(c).toMatchObject({
      prefix: 'fb',
      dlqRetentionMs: 14 * 86_400_000,
      dedupWindowMs: 30 * 86_400_000,
    });
    expect(c.concurrency.facebook).toBe(2);
    expect(c.defaultPolicy.maxAttempts).toBe(8);
  });

  it('reads per-platform concurrency and retry overrides', () => {
    const c = loadJobsConfig({
      JOB_CONCURRENCY: '4',
      JOB_CONCURRENCY_YOUTUBE: '0',
      JOB_MAX_ATTEMPTS: '5',
      JOB_BACKOFF_BASE_MS: '1000',
      JOB_BACKOFF_MAX_MS: '60000',
    });
    expect(c.concurrency.facebook).toBe(4);
    expect(c.concurrency.youtube).toBe(0);
    expect(c.defaultPolicy).toMatchObject({
      maxAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
    });
  });

  it.each([
    [{ JOB_QUEUE_PREFIX: 'Bad:Prefix' }],
    [{ JOB_CONCURRENCY: '65' }],
    [{ JOB_MAX_ATTEMPTS: '0' }],
    [{ JOB_BACKOFF_BASE_MS: '5000', JOB_BACKOFF_MAX_MS: '1000' }],
    [{ JOB_DLQ_RETENTION_DAYS: '0' }],
  ])('rejects %o', (env) => {
    expect(() => loadJobsConfig(env)).toThrow();
  });
});

describe('assertDedupWindow', () => {
  const jobs = new JobRegistry();
  jobs.register({
    type: 't',
    platforms: 'all',
    payload: z.strictObject({}),
    externalRef: () => 'x',
    handle: async () => ({}),
  });

  it('accepts defaults (30 d >= ~1 d + 14 d)', () => {
    expect(() => assertDedupWindow(loadJobsConfig({}), jobs, ['facebook'])).not.toThrow();
  });

  it('rejects a window shorter than horizon + retention', () => {
    expect(() =>
      assertDedupWindow(loadJobsConfig({ JOB_DEDUP_WINDOW_DAYS: '14' }), jobs, ['facebook']),
    ).toThrow('JOB_DEDUP_WINDOW_DAYS must cover');
  });
});
