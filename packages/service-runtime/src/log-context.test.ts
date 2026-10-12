import { expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { currentLogContext, withLogContext } from './log-context.js';

it('binds and nests correlation fields', async () => {
  await withLogContext({ tenant_id: 'org-1', connector_type: 'youtube' }, async () => {
    await Promise.resolve();
    await withLogContext({ job_id: 'job-1' }, async () => {
      expect(currentLogContext()).toEqual({
        tenant_id: 'org-1',
        connector_type: 'youtube',
        job_id: 'job-1',
      });
    });
    expect(currentLogContext()).toEqual({ tenant_id: 'org-1', connector_type: 'youtube' });
  });
  expect(currentLogContext()).toEqual({});
});

it('context values must be safe ids', () => {
  withLogContext({ tenant_id: 'a"}\n{"level":"error', job_id: 'ok-1' }, () => {
    expect(currentLogContext()).toEqual({ job_id: 'ok-1' });
  });
});

it('adds context fields to every log line', () => {
  const lines: string[] = [];
  const log = createLogger('worker', 'debug', (l) => lines.push(l));
  withLogContext({ tenant_id: 'org-1', connector_id: 'c-1', job_id: 'j-1' }, () =>
    log.info('job.completed'),
  );
  expect(JSON.parse(lines[0]!)).toMatchObject({
    level: 'info',
    service: 'worker',
    msg: 'job.completed',
    tenant_id: 'org-1',
    connector_id: 'c-1',
    job_id: 'j-1',
  });
});
