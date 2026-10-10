import { describe, expect, it } from 'vitest';
import { parseEnqueueArgs, selftestJobs } from './enqueue-selftest.js';

const runId = '1b4e28ba-2fa1-4d2b-8f3e-1c6a2d9e7f10';

describe('parseEnqueueArgs', () => {
  it('parses valid arguments with a default delay', () => {
    expect(parseEnqueueArgs(['--run-id', runId, '--count', '3'])).toEqual({
      runId,
      count: 3,
      delayMs: 0,
    });
  });
  it.each([
    [['--count', '3']],
    [['--run-id', 'x; rm -rf /', '--count', '3']],
    [['--run-id', runId, '--count', '0']],
    [['--run-id', runId, '--count', '10001']],
    [['--run-id', runId, '--count', '1e2']],
    [['--run-id', runId, '--count', '3', '--delay-ms', '2000']],
    [['--run-id', runId, '--count', '3', '--unknown', 'x']],
  ])('rejects %j', (argv) => {
    expect(() => parseEnqueueArgs(argv)).toThrow();
  });
});

describe('selftestJobs', () => {
  it('produces deterministic, colon-free job ids', () => {
    const jobs = selftestJobs({ runId, count: 2, delayMs: 7 });
    expect(jobs.map((j) => j.opts.jobId)).toEqual([`selftest_${runId}_0`, `selftest_${runId}_1`]);
    expect(jobs.every((j) => !j.opts.jobId.includes(':'))).toBe(true);
    expect(jobs[0]?.data).toEqual({ delayMs: 7 });
  });
});
