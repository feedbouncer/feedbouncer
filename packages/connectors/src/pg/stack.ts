// The production wiring of the framework services over Postgres and Redis,
// shared by the API and the worker so both build identical adapters.
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { CredentialStore, type KeyProvider } from '@feedbouncer/secrets';
import type { Logger, Secret } from '@feedbouncer/service-runtime';
import { redisBudget, type RateBudget } from '../budget.js';
import { systemClock } from '../clock.js';
import type { Connector } from '../connector.js';
import { createSafeHttp } from '../http.js';
import { OAuthFlow } from '../oauth.js';
import type {
  ConnectionDirectory,
  CredentialVault,
  DeliveryLedger,
  MembershipReader,
  OAuthGrantStore,
  OAuthStateStore,
  SyncRecorder,
  WebhookSecretSource,
} from '../ports.js';
import type { ConnectorRegistry } from '../registry.js';
import { ConnectorRuntime, type ConnectorCallObserver } from '../runtime.js';
import { TokenManager } from '../tokens.js';
import type { Platform } from '../types.js';
import { WebhookGate, type WebhookObserver } from '../webhook.js';
import { PgConnectionDirectory } from './directory.js';
import { PgDeliveryLedger } from './ledger.js';
import { PgMembershipReader } from './membership.js';
import { PgOAuthGrantStore } from './oauth-grant.js';
import { PgOAuthStateStore } from './oauth-state.js';
import { PgRefreshLock } from './refresh-lock.js';
import { PgCredentialVault } from './vault.js';
import { PgWebhookSecrets } from './webhook-secrets.js';

export interface PgConnectorStack {
  directory: ConnectionDirectory;
  vault: CredentialVault;
  states: OAuthStateStore;
  grants: OAuthGrantStore;
  memberships: MembershipReader;
  ledger: DeliveryLedger;
  secrets: WebhookSecretSource;
  budget: RateBudget;
  tokens: TokenManager;
  runtime: ConnectorRuntime;
  oauth: OAuthFlow;
  webhooks: WebhookGate;
  store: CredentialStore;
}

/** Builds every adapter and service; no I/O happens until a service is used. */
export function buildPgConnectorStack(d: {
  pool: pg.Pool;
  /** Refresh-lock sessions get their own small pool, never the data pool. */
  lockPool: pg.Pool;
  redis: Redis;
  redisPrefix: string;
  keys: KeyProvider;
  registry: ConnectorRegistry;
  appSecrets: ReadonlyMap<Platform, Secret>;
  redirectUri: (p: Platform) => string;
  log: Logger;
  workerId: string;
  observer?: ConnectorCallObserver;
  webhookObserver?: WebhookObserver;
  sync?: SyncRecorder;
  /** Decorates the directory every service uses (e.g. to notify on reconnect). */
  wrapDirectory?: (d: ConnectionDirectory) => ConnectionDirectory;
}): PgConnectorStack {
  const { pool, registry, log } = d;
  const clock = systemClock;
  const store = new CredentialStore(pool, d.keys);
  const base = new PgConnectionDirectory(pool);
  const directory = d.wrapDirectory ? d.wrapDirectory(base) : base;
  const vault = new PgCredentialVault(store, pool, log);
  const states = new PgOAuthStateStore(pool, d.keys);
  const grants = new PgOAuthGrantStore(pool, d.keys);
  const memberships = new PgMembershipReader(pool);
  const ledger = new PgDeliveryLedger(pool, d.workerId);
  const secrets = new PgWebhookSecrets(pool, store, d.appSecrets);
  const budget = redisBudget(d.redis, d.redisPrefix);
  const http = (c: Connector) => createSafeHttp({ allowedHosts: c.capabilities.apiHosts });
  const sync = d.sync ? { sync: d.sync } : {};
  const tokens = new TokenManager({
    vault,
    directory,
    lock: new PgRefreshLock(d.lockPool),
    clock,
    log,
    oauthContext: (c) => ({
      http: http(c),
      signal: AbortSignal.timeout(15_000),
      redirectUri: d.redirectUri(c.platform),
    }),
  });
  return {
    directory,
    vault,
    states,
    grants,
    memberships,
    ledger,
    secrets,
    budget,
    tokens,
    store,
    runtime: new ConnectorRuntime({
      registry,
      directory,
      vault,
      tokens,
      budget,
      clock,
      log,
      http,
      ...(d.observer ? { observer: d.observer } : {}),
      ...sync,
    }),
    oauth: new OAuthFlow({
      registry,
      states,
      memberships,
      directory,
      vault,
      grants,
      clock,
      log,
      redirectUri: d.redirectUri,
      http,
    }),
    webhooks: new WebhookGate({
      registry,
      secrets,
      ledger,
      clock,
      log,
      ...(d.webhookObserver ? { observer: d.webhookObserver } : {}),
      ...sync,
    }),
  };
}
