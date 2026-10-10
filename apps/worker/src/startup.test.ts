import { describe, expect, it } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { reportStartupFailure } from './startup.js';

describe('reportStartupFailure', () => {
  it('logs the error and its cause without credentials', () => {
    const lines: string[] = [];
    const log = createLogger('worker', 'error', (l) => lines.push(l));
    const cause = new Error('connect failed for postgresql://fb:s3cret-pw@postgres:5432/fb');
    reportStartupFailure(log, new Error('Dependencies not ready after 60000ms', { cause }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('s3cret-pw');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'error',
      msg: 'startup failed',
      errorMessage: 'Dependencies not ready after 60000ms',
      causeMessage: expect.stringContaining('postgres:5432'),
    });
  });

  it('handles errors without a cause', () => {
    const lines: string[] = [];
    const log = createLogger('worker', 'error', (l) => lines.push(l));
    reportStartupFailure(log, 'boom');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ msg: 'startup failed', error: 'NonError' });
  });
});
