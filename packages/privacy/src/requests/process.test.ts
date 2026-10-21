import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Logger } from '@feedbouncer/service-runtime';
import type { PgPrivacyRequestStore } from './store.js';

const erase = vi.hoisted(() => vi.fn());
vi.mock('../erase/erase.js', () => ({ eraseSubject: erase }));

const { processPrivacyRequest } = await import('./process.js');

const log = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function deps(store: Partial<PgPrivacyRequestStore>) {
  return {
    store: store as PgPrivacyRequestStore,
    pool: {} as pg.Pool,
    exportDir: '/unused',
    exportTtlHours: 1,
    batchSize: 10,
    log,
    heartbeatMs: 10,
  };
}

afterEach(() => vi.clearAllMocks());

describe('processPrivacyRequest heartbeat', () => {
  it('reports progress while a request runs, and stops once it ends', async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const store = {
      claim: vi.fn().mockResolvedValue({
        id: 'r1',
        organizationId: 'o1',
        kind: 'erasure',
        mode: 'execute',
        subjects: [],
        keepRuleEntriesReason: null,
      }),
      heartbeat,
      finish: vi.fn().mockResolvedValue(undefined),
    };
    erase.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ found: false, counts: {}, coverage: 'c' }), 80),
        ),
    );

    await processPrivacyRequest(deps(store), 'r1');

    expect(heartbeat).toHaveBeenCalledWith('r1');
    const calls = heartbeat.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(heartbeat.mock.calls.length).toBe(calls);
  });

  it('stops reporting when the request fails', async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const store = {
      claim: vi.fn().mockResolvedValue({
        id: 'r1',
        organizationId: 'o1',
        kind: 'erasure',
        mode: 'execute',
        subjects: [],
        keepRuleEntriesReason: null,
      }),
      heartbeat,
      fail: vi.fn().mockResolvedValue(undefined),
    };
    erase.mockRejectedValue(new Error('boom'));

    await expect(processPrivacyRequest(deps(store), 'r1')).rejects.toThrow();
    const calls = heartbeat.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(heartbeat.mock.calls.length).toBe(calls);
  });
});
