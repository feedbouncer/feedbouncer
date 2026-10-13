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

it('forwards events and waits to the sink and survives a throwing sink', () => {
  const seen: string[] = [];
  const m = new JobMetrics(
    createLogger('t', 'error', () => {}),
    {
      onEvent: (e, p, t) => seen.push(`${e}:${p}:${t}`),
      onWait: (p, ms) => seen.push(`wait:${p}:${ms}`),
    },
  );
  m.record('dead_lettered', {
    platform: 'youtube',
    jobType: 'scripted',
    ledgerId: '00000000-0000-4000-8000-000000000001',
  });
  m.observeWait('youtube', 250);
  expect(seen).toEqual(['dead_lettered:youtube:scripted', 'wait:youtube:250']);
  const bad = new JobMetrics(
    createLogger('t', 'error', () => {}),
    {
      onEvent: () => {
        throw new Error('x');
      },
      onWait: () => {
        throw new Error('x');
      },
    },
  );
  expect(() => bad.record('completed', { platform: 'youtube', jobType: 'scripted' })).not.toThrow();
  expect(() => bad.observeWait('youtube', 1)).not.toThrow();
});

it('job log lines carry job_id and connector_type', () => {
  const lines: string[] = [];
  const m = new JobMetrics(createLogger('t', 'debug', (l) => lines.push(l)));
  m.record('completed', {
    platform: 'youtube',
    jobType: 'scripted',
    ledgerId: '00000000-0000-4000-8000-000000000001',
  });
  expect(JSON.parse(lines[0]!)).toMatchObject({
    msg: 'job.completed',
    job_id: '00000000-0000-4000-8000-000000000001',
    connector_type: 'youtube',
  });
});
