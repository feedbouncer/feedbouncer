import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { describe, expect, it } from 'vitest';
import { buildThreadsDeps } from './threads-deps.js';

const log = createLogger('threads-deps-test', 'error', () => {});
const threads = {
  appId: '2220001112223334',
  appSecret: new Secret('threads-secret-0123456789'),
  webhookVerifyToken: null,
  pollIntervalSec: 600,
  discoveryIntervalSec: 900,
};

describe('buildThreadsDeps', () => {
  it('is null when Threads is not enabled', () => {
    expect(buildThreadsDeps({ threads: null }, log)).toBeNull();
  });

  it('registers the Threads connector with its own app secret', () => {
    const d = buildThreadsDeps({ threads }, log)!;
    expect(d.connectors.map((c) => c.platform)).toEqual(['threads']);
    expect(d.connectors[0]!.webhook).toBeDefined();
    expect(d.appSecrets).toEqual({ threads: threads.appSecret });
  });
});
