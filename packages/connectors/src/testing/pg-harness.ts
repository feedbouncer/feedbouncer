// Conformance harness over real Postgres and Redis. Not part of the package
// entry: it needs devDependencies and DATABASE_URL / REDIS_URL, like
// apps/api/src/testing/harness.ts. One migrated scratch database is shared by
// the harnesses of a test file (each harness seeds its own tenant);
// call closePgHarnessDatabase() in afterAll.
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type pg from 'pg';
import type { Role } from '@feedbouncer/authz';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { CredentialStore } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { redisBudget } from '../budget.js';
import type { Clock } from '../clock.js';
import type { CredentialVault, TokenRecord } from '../ports.js';
import {
  PgConnectionDirectory,
  PgCredentialVault,
  PgDeliveryLedger,
  PgMembershipReader,
  PgOAuthStateStore,
  PgRefreshLock,
  PgWebhookSecrets,
} from '../pg/index.js';
import { createReferenceConnector } from '../reference/connector.js';
import { InMemoryPlatform } from '../reference/platform.js';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { REAL_TIME_STATE_TTL_MS, type ConformanceHarness } from './conformance.js';
import { assembleStack, platformDriver } from './runtime.js';

type Database = Awaited<ReturnType<typeof migratedDb>>;
let shared: Promise<Database> | undefined;

function database(): Promise<Database> {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL must be set for connector integration tests.');
  shared ??= migratedDb();
  return shared;
}

export async function closePgHarnessDatabase(): Promise<void> {
  const db = await shared;
  shared = undefined;
  await db?.close();
}

/** Makes the next access-token write throw once, after the refresh token was written. */
class FaultInjectingVault implements CredentialVault {
  #failAccess = false;
  constructor(private readonly inner: CredentialVault) {}
  failNextAccessWrite(): void {
    this.#failAccess = true;
  }
  readTokens(scope: ConnectionScope) {
    return this.inner.readTokens(scope);
  }
  writeRefreshToken(scope: ConnectionScope, t: TokenRecord) {
    return this.inner.writeRefreshToken(scope, t);
  }
  async writeAccessToken(scope: ConnectionScope, t: TokenRecord): Promise<void> {
    if (this.#failAccess) {
      this.#failAccess = false;
      throw new Error('simulated storage failure');
    }
    return this.inner.writeAccessToken(scope, t);
  }
}

/**
 * Membership is per organization, so a grant ensures a membership exists
 * (never changes an existing role) after checking the brand belongs to the organization.
 */
class GrantingMembershipReader extends PgMembershipReader {
  constructor(private readonly db: pg.Pool) {
    super(db);
  }
  async grant(organizationId: string, brandId: string, userId: string, role: Role): Promise<void> {
    const brand = await this.db.query(
      'SELECT 1 FROM brand WHERE id = $1 AND organization_id = $2',
      [brandId, organizationId],
    );
    if (brand.rowCount !== 1) throw new Error('harness: brand is not in the organization');
    await this.db.query(
      `INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [organizationId, userId, role],
    );
  }
}

export async function createPgHarness(flavor: 'push' | 'poll'): Promise<ConformanceHarness> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL must be set for connector integration tests.');
  const db = await database();
  const label = `conf-${randomBytes(6).toString('hex')}`;
  const tenant = await seedTenant(db.c, label);
  const impostorUser = (
    await db.c.query<{ id: string }>('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
      `impostor-${label}@example.test`,
    ])
  ).rows[0]!.id;
  const impostorBrand = (
    await db.c.query<{ id: string }>(
      'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
      [tenant.organizationId, `Other brand ${label}`],
    )
  ).rows[0]!.id;

  const pool = createPool(db.db.url, {
    applicationName: 'connectors-conformance',
    onIdleError: () => {},
  });
  // Refresh-lock sessions get their own small pool, never the data pool.
  const lockPool = createPool(db.db.url, {
    applicationName: 'connectors-conformance-lock',
    max: 4,
    onIdleError: () => {},
  });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  redis.on('error', () => {});
  const budgetPrefix = `fb:test:${randomUUID()}`;

  const redirectUri = 'https://app.feedbouncer.test/oauth/callback';
  const webhookSecret =
    flavor === 'push' ? `ref-webhook-secret-${randomBytes(8).toString('hex')}` : null;

  // The platform's token expiry and the stack's clock must agree on "now":
  // skipAhead() simulates time passing for the whole harness, not just the
  // stack, so a freshly-refreshed token's expiry (computed on this clock)
  // stays comfortably past TokenManager's skew margin after a skip.
  let skewMs = 0;
  const clock: Clock = { now: () => Date.now() + skewMs };

  const platform = new InMemoryPlatform({
    clock,
    rotateRefreshTokens: flavor === 'push',
    accessTokenTtlMs: 3_600_000,
    webhookSecret,
    redirectUri,
    // Facebook accounts are unique across tenants, and harnesses share one database.
    accountIdPrefix: label,
  });
  const connector = createReferenceConnector(platform, { flavor, redirectUri });

  const keys = testKeyring(['k1']);
  const store = new CredentialStore(pool, keys);
  const log = createLogger('conformance-pg', 'error', () => {});
  const vault = new FaultInjectingVault(new PgCredentialVault(store, pool, log));
  const app = new Map(
    webhookSecret ? [[connector.platform, new Secret(webhookSecret)] as const] : [],
  );
  const stack = assembleStack(
    connector,
    {
      directory: new PgConnectionDirectory(pool),
      vault,
      lock: new PgRefreshLock(lockPool),
      states: new PgOAuthStateStore(pool, keys),
      memberships: new GrantingMembershipReader(pool),
      ledger: new PgDeliveryLedger(pool, `conformance-${label}`),
      budget: redisBudget(redis, budgetPrefix),
      secrets: new PgWebhookSecrets(pool, store, app),
      actor: {
        userId: tenant.userId,
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
      },
      faults: { failNextAccessWrite: () => vault.failNextAccessWrite() },
    },
    redirectUri,
    { stateTtlMs: REAL_TIME_STATE_TTL_MS, clock },
  );

  return {
    connector,
    driver: platformDriver(platform),
    stack,
    skipClock: (ms) => {
      skewMs += ms;
    },
    impostors: { userId: impostorUser, brandId: impostorBrand },
    async cleanup() {
      const leftovers = await redis.keys(`${budgetPrefix}:*`).catch(() => []);
      if (leftovers.length) await redis.del(...leftovers).catch(() => undefined);
      redis.disconnect();
      await Promise.all([pool.end(), lockPool.end()]);
    },
  };
}
