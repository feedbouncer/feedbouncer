import { describe, expect, it } from 'vitest';
import { validateJobKey } from './job-once.js';

describe('validateJobKey', () => {
  const ok = { queue: 'system', jobId: 'selftest_x_1', workerId: 'abc123' };
  it('accepts a normal key', () => {
    expect(() => validateJobKey(ok)).not.toThrow();
  });
  it.each([
    ['queue', ''],
    ['jobId', ''],
    ['workerId', ''],
    ['jobId', 'x'.repeat(201)],
  ] as const)('rejects %s=%j', (field, value) => {
    expect(() => validateJobKey({ ...ok, [field]: value })).toThrow(RangeError);
  });
});
