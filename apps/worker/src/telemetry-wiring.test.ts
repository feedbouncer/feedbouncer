import { describe, expect, it } from 'vitest';
import type { createPool } from '@feedbouncer/db';
import type { PgJobLedger } from '@feedbouncer/jobs';
import { createLogger } from '@feedbouncer/service-runtime';
import { buildWorkerTelemetry } from './telemetry.js';
import { testWorkerEnv } from './testing/env-fixture.js';

const log = createLogger('test', 'error', () => {});

describe('buildWorkerTelemetry', () => {
  it('registers health and queue gauges and job/connector sinks on one registry', async () => {
    const pool = {
      query: async () => {
        throw new Error('no db in unit test');
      },
    } as unknown as ReturnType<typeof createPool>;
    const ledger = {
      queueStats: async () => [{ platform: 'youtube', depth: 2, oldestAgeMs: 1000 }],
    } as unknown as PgJobLedger;
    const t = buildWorkerTelemetry({ env: testWorkerEnv(), pool, ledger, log });
    t.jobSink.onEvent('completed', 'youtube', 'scripted');
    const text = await t.metrics.registry.metrics();
    expect(text).toMatch(/feedbouncer_queue_depth\{[^}]*\} 2/);
    expect(text).toMatch(
      /feedbouncer_telemetry_collect_errors_total\{[^}]*collector="connector_health"/,
    );
    expect(text).toMatch(/feedbouncer_jobs_total\{[^}]*outcome="completed"/);
    await t.tracing.shutdown();
  });
});
