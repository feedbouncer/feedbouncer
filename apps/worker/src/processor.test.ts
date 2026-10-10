import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import {
  SELFTEST_JOB,
  SYSTEM_QUEUE,
  createProcessor,
  parseSelftestData,
  type RunOnce,
} from './processor.js';

const log = createLogger('test', 'error', () => {});

function setup(outcome: 'processed' | 'duplicate' = 'processed') {
  const sleep = vi.fn(async () => {});
  const runOnce = vi.fn<RunOnce>(async (_key, work) => {
    if (outcome === 'processed') await work();
    return outcome;
  });
  return {
    sleep,
    runOnce,
    process: createProcessor({ runOnce, workerId: 'replica-1', log, sleep }),
  };
}
const job = (over: Partial<{ id: string; name: string; data: unknown }> = {}) => ({
  id: 'selftest_r_1',
  name: SELFTEST_JOB,
  queueName: SYSTEM_QUEUE,
  data: { delayMs: 5 },
  ...over,
});

describe('createProcessor', () => {
  it('runs selftest work through runOnce keyed by queue, job id and replica', async () => {
    const { process, runOnce, sleep } = setup();
    await expect(process(job())).resolves.toBe('processed');
    expect(runOnce).toHaveBeenCalledWith(
      { queue: SYSTEM_QUEUE, jobId: 'selftest_r_1', workerId: 'replica-1' },
      expect.any(Function),
    );
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it('does not run work for a duplicate delivery', async () => {
    const { process, sleep } = setup('duplicate');
    await expect(process(job())).resolves.toBe('duplicate');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects jobs without an id, with unknown names, or with invalid data', async () => {
    const { process } = setup();
    await expect(process({ ...job(), id: undefined })).rejects.toThrow(/without an id/);
    await expect(process(job({ name: 'rm -rf' }))).rejects.toThrow(/Unknown job/);
    await expect(process(job({ data: { delayMs: 5_000 } }))).rejects.toThrow(/delayMs/);
  });
});

describe('parseSelftestData', () => {
  it('accepts the bounds', () => {
    expect(parseSelftestData({ delayMs: 0 })).toEqual({ delayMs: 0 });
    expect(parseSelftestData({ delayMs: 1_000 })).toEqual({ delayMs: 1_000 });
  });
  it.each([null, 'x', {}, { delayMs: -1 }, { delayMs: 1.5 }, { delayMs: 1001 }])(
    'rejects %j',
    (data) => {
      expect(() => parseSelftestData(data)).toThrow(/delayMs/);
    },
  );
});
