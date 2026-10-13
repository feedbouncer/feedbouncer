import type { Redis } from 'ioredis';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import type { ConnectionDirectory } from '../ports.js';
import { ConnectorRegistry } from '../registry.js';
import { PgConnectionDirectory } from './directory.js';
import { buildPgConnectorStack } from './stack.js';

const MEMBERS = [
  'directory',
  'vault',
  'states',
  'grants',
  'memberships',
  'ledger',
  'secrets',
  'budget',
  'tokens',
  'runtime',
  'oauth',
  'webhooks',
  'store',
] as const;

const deps = (wrapDirectory?: (d: ConnectionDirectory) => ConnectionDirectory) => ({
  pool: {} as pg.Pool,
  lockPool: {} as pg.Pool,
  redis: {} as Redis,
  redisPrefix: 'fb:test',
  keys: testKeyring(['k1']),
  registry: new ConnectorRegistry(),
  appSecrets: new Map([['facebook' as const, new Secret('app-secret')]]),
  redirectUri: () => 'https://app.test/oauth/callback',
  log: createLogger('stack-test', 'error', () => {}),
  workerId: 'w1',
  ...(wrapDirectory ? { wrapDirectory } : {}),
});

describe('buildPgConnectorStack', () => {
  it('builds every service without doing I/O', () => {
    const stack = buildPgConnectorStack(deps());
    for (const m of MEMBERS) expect(stack[m], m).toBeDefined();
    expect(Object.keys(stack).sort()).toEqual([...MEMBERS].sort());
    expect(stack.directory).toBeInstanceOf(PgConnectionDirectory);
  });

  it('uses the wrapped directory', () => {
    let inner: ConnectionDirectory | undefined;
    const wrapped = {} as ConnectionDirectory;
    const stack = buildPgConnectorStack(
      deps((d) => {
        inner = d;
        return wrapped;
      }),
    );
    expect(inner).toBeInstanceOf(PgConnectionDirectory);
    expect(stack.directory).toBe(wrapped);
  });
});
