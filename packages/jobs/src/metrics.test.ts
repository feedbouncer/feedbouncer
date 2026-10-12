import { expect, it } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { JobMetrics } from './metrics.js';

it('counts per platform and logs structured events', () => {
  const lines: string[] = [];
  const m = new JobMetrics(createLogger('t', 'debug', (l) => lines.push(l)));
  m.record('enqueued', { platform: 'facebook', jobType: 'x', ledgerId: 'id1' });
  m.record('enqueued', { platform: 'facebook', jobType: 'x' });
  m.record('dead_lettered', { platform: 'youtube', jobType: 'x', reason: 'non_retryable' });
  expect(m.count('enqueued', 'facebook')).toBe(2);
  expect(m.count('enqueued', 'youtube')).toBe(0);
  expect(m.snapshot().youtube?.dead_lettered).toBe(1);
  expect(JSON.parse(lines[2]!)).toMatchObject({
    msg: 'job.dead_lettered',
    level: 'error',
    platform: 'youtube',
    reason: 'non_retryable',
  });
});
