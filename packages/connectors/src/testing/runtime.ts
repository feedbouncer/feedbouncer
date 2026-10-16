// Test assembly of the framework services. `assembleStack` takes any set of
// ports (memory here, Postgres/Redis in the integration run) so the same
// conformance suite exercises both.
import { randomBytes } from 'node:crypto';
import type { Role } from '@feedbouncer/authz';
import { Secret, createLogger, type Logger } from '@feedbouncer/service-runtime';
import { memoryBudget, type RateBudget } from '../budget.js';
import { systemClock, type Clock } from '../clock.js';
import type { Connector } from '../connector.js';
import { createSafeHttp } from '../http.js';
import {
  MemoryConnectionDirectory,
  MemoryCredentialVault,
  MemoryDeliveryLedger,
  MemoryMembershipReader,
  MemoryOAuthGrantStore,
  MemoryOAuthStateStore,
  MemoryRefreshLock,
  StaticWebhookSecrets,
} from '../memory.js';
import { OAuthFlow, type OAuthActor } from '../oauth.js';
import type {
  ConnectionDirectory,
  CredentialVault,
  DeliveryLedger,
  MembershipReader,
  OAuthGrantStore,
  OAuthStateStore,
  RefreshLock,
  SyncRecorder,
  WebhookSecretSource,
} from '../ports.js';
import { createReferenceConnector } from '../reference/connector.js';
import { InMemoryPlatform } from '../reference/platform.js';
import { ConnectorRegistry } from '../registry.js';
import { ConnectorRuntime, type ConnectorCallObserver } from '../runtime.js';
import { TokenManager } from '../tokens.js';
import { WebhookGate, type WebhookObserver } from '../webhook.js';
import type { ConformanceHarness, PlatformDriver } from './conformance.js';

export function capturingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger('conformance', 'debug', (l) => lines.push(l)), lines };
}

export interface StackPorts {
  directory: ConnectionDirectory;
  vault: CredentialVault;
  lock: RefreshLock;
  states: OAuthStateStore;
  /** Needed only by multi-account (`accountSelection: 'multiple'`) connectors. */
  grants?: OAuthGrantStore;
  memberships: MembershipReader & {
    grant?(
      organizationId: string,
      brandId: string,
      userId: string,
      role: Role,
    ): void | Promise<void>;
  };
  ledger: DeliveryLedger;
  budget: RateBudget;
  secrets: WebhookSecretSource;
  actor: OAuthActor;
  /**
   * Required: makes the next access-token write throw once. The rotation-safety
   * scenario depends on it, so a port set without it cannot be
   * assembled. The Pg run wraps its vault in a decorator that throws once.
   */
  faults: { failNextAccessWrite(): void };
}
export interface Stack extends StackPorts {
  registry: ConnectorRegistry;
  tokens: TokenManager;
  runtime: ConnectorRuntime;
  oauth: OAuthFlow;
  webhooks: WebhookGate;
  log: Logger;
  lines: string[];
  redirectUri: string;
  clock: Clock;
}

/** Wires the framework services over the given ports. The HTTP client is built from the connector's own `apiHosts`. */
export function assembleStack(
  connector: Connector,
  ports: StackPorts,
  redirectUri: string,
  opts: {
    stateTtlMs?: number;
    clock?: Clock;
    observer?: ConnectorCallObserver;
    webhookObserver?: WebhookObserver;
    sync?: SyncRecorder;
    /** Replaces the global fetch under every SafeHttp the framework builds (fake platform doubles). */
    fetch?: typeof fetch;
  } = {},
): Stack {
  const { log, lines } = capturingLogger();
  const clock = opts.clock ?? systemClock;
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const http = (c: Connector) =>
    createSafeHttp({
      allowedHosts: c.capabilities.apiHosts,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  const tokens = new TokenManager({
    vault: ports.vault,
    directory: ports.directory,
    lock: ports.lock,
    clock,
    log,
    oauthContext: (c) => ({ http: http(c), signal: AbortSignal.timeout(15_000), redirectUri }),
  });
  return {
    ...ports,
    registry,
    tokens,
    log,
    lines,
    redirectUri,
    clock,
    runtime: new ConnectorRuntime({
      registry,
      directory: ports.directory,
      vault: ports.vault,
      tokens,
      budget: ports.budget,
      clock,
      log,
      http,
      ...(opts.observer ? { observer: opts.observer } : {}),
      ...(opts.sync ? { sync: opts.sync } : {}),
    }),
    oauth: new OAuthFlow({
      registry,
      states: ports.states,
      memberships: ports.memberships,
      directory: ports.directory,
      vault: ports.vault,
      ...(ports.grants ? { grants: ports.grants } : {}),
      clock,
      log,
      redirectUri: () => redirectUri,
      http,
      ...(opts.stateTtlMs !== undefined ? { stateTtlMs: opts.stateTtlMs } : {}),
    }),
    webhooks: new WebhookGate({
      registry,
      secrets: ports.secrets,
      ledger: ports.ledger,
      clock,
      log,
      ...(opts.webhookObserver ? { observer: opts.webhookObserver } : {}),
      ...(opts.sync ? { sync: opts.sync } : {}),
    }),
  };
}

export async function createMemoryStack(
  connector: Connector,
  opts: {
    webhookSecret: string | null;
    redirectUri: string;
    clock?: Clock;
    fetch?: typeof fetch;
  },
): Promise<Stack> {
  const clock = opts.clock ?? systemClock;
  const actor = { userId: 'user-a', organizationId: 'org-a', brandId: 'brand-a' };
  const memberships = new MemoryMembershipReader();
  memberships.grant(actor.organizationId, actor.brandId, actor.userId, 'admin');
  const vault = new MemoryCredentialVault();
  const app = new Map(
    opts.webhookSecret ? [[connector.platform, new Secret(opts.webhookSecret)] as const] : [],
  );
  return assembleStack(
    connector,
    {
      directory: new MemoryConnectionDirectory(clock),
      vault,
      lock: new MemoryRefreshLock(),
      states: new MemoryOAuthStateStore(clock),
      grants: new MemoryOAuthGrantStore(clock),
      memberships,
      ledger: new MemoryDeliveryLedger(),
      budget: memoryBudget(),
      secrets: new StaticWebhookSecrets(app),
      actor,
      faults: { failNextAccessWrite: () => vault.failNextWrite('access') },
    },
    opts.redirectUri,
    { clock, ...(opts.fetch ? { fetch: opts.fetch } : {}) },
  );
}

/** Adapts the synchronous platform controls to the async driver the suite uses. */
export function platformDriver(p: InMemoryPlatform): PlatformDriver {
  return {
    createAccount: async () => p.createAccount(),
    consent: async (url, accountId) => p.consent(url, accountId),
    seedSource: async (accountId) => p.seedSource(accountId),
    seedComments: async (accountId, sourceId, n) => p.seedComments(accountId, sourceId, n),
    deleteComment: async (sourceId, commentId) => p.deleteComment(sourceId, commentId),
    commentState: async (sourceId, commentId) => p.commentState(sourceId, commentId),
    expireAccessTokens: async () => p.expireAccessTokens(),
    revokeGrant: async (accountId) => p.revokeGrant(accountId),
    throttleNext: async (retryAfterSec) => p.throttleNext(retryAfterSec),
    calls: async (op) => p.calls(op),
    issuedSecrets: async () => p.issuedSecrets(),
    signedDelivery: async (accountId, commentId, sourceId, opts) =>
      p.signedDelivery(accountId, commentId, sourceId, opts),
  };
}

export async function createInMemoryHarness(flavor: 'push' | 'poll'): Promise<ConformanceHarness> {
  const redirectUri = 'https://app.feedbouncer.test/oauth/callback';
  const webhookSecret =
    flavor === 'push' ? `ref-webhook-secret-${randomBytes(8).toString('hex')}` : null;
  const platform = new InMemoryPlatform({
    clock: systemClock,
    rotateRefreshTokens: flavor === 'push',
    accessTokenTtlMs: 3_600_000,
    webhookSecret,
    redirectUri,
  });
  const connector = createReferenceConnector(platform, { flavor, redirectUri });
  const stack = await createMemoryStack(connector, { webhookSecret, redirectUri });
  return { connector, driver: platformDriver(platform), stack };
}
