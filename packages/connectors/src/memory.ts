// In-memory adapters: conformance runs without Postgres or Redis. Semantics
// match the Pg adapters (src/pg), which the integration suite verifies.
import { randomUUID } from 'node:crypto';
import type { Role } from '@feedbouncer/authz';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { ErrorClass, Secret } from '@feedbouncer/service-runtime';
import { systemClock, type Clock } from './clock.js';
import {
  ConnectionTakenError,
  type ConnectionDirectory,
  type ConnectionRecord,
  type CredentialVault,
  type DeliveryLedger,
  type MembershipReader,
  type OAuthGrantStore,
  type OAuthStateStore,
  type PendingGrant,
  type PendingAuthorization,
  type ReauthReason,
  type RefreshLock,
  type StateBinding,
  type SyncRecorder,
  type TokenRecord,
  type WebhookSecretSource,
} from './ports.js';
import { scopeKey } from './scope.js';
import type { Platform } from './types.js';

const sameScope = (a: ConnectionScope, b: ConnectionScope) =>
  a.organizationId === b.organizationId &&
  a.brandId === b.brandId &&
  a.connectionId === b.connectionId;

export class MemoryConnectionDirectory implements ConnectionDirectory {
  readonly #rows = new Map<string, { rec: ConnectionRecord; reason: string | null }>();

  seed(rec: ConnectionRecord): void {
    this.#rows.set(rec.scope.connectionId, { rec, reason: null });
  }
  statusReason(connectionId: string): string | null {
    return this.#rows.get(connectionId)?.reason ?? null;
  }
  async load(scope: ConnectionScope): Promise<ConnectionRecord | null> {
    const row = this.#rows.get(scope.connectionId);
    return row && sameScope(row.rec.scope, scope) ? row.rec : null;
  }
  async markReauthRequired(scope: ConnectionScope, reason: ReauthReason): Promise<boolean> {
    const row = this.#rows.get(scope.connectionId);
    if (
      !row ||
      !sameScope(row.rec.scope, scope) ||
      !['active', 'paused', 'error'].includes(row.rec.status)
    )
      return false;
    this.#rows.set(scope.connectionId, {
      rec: { ...row.rec, status: 'reconnect_required' },
      reason,
    });
    return true;
  }
  async upsertPending(i: {
    organizationId: string;
    brandId: string;
    platform: Platform;
    externalAccountId: string;
    displayName: string | null;
    grantedScopes: readonly string[];
  }) {
    for (const row of this.#rows.values()) {
      const { rec } = row;
      if (
        rec.scope.brandId === i.brandId &&
        rec.platform === i.platform &&
        rec.externalAccountId === i.externalAccountId
      ) {
        if (rec.scope.organizationId !== i.organizationId)
          throw new Error('brand belongs to another organization');
        if (rec.status === 'revoked' && row.reason === 'user_disconnected') {
          this.#rows.set(rec.scope.connectionId, {
            rec: { ...rec, status: 'reconnect_required' },
            reason: 'oauth_pending',
          });
        }
        return { scope: rec.scope, created: false };
      }
    }
    if (i.platform === 'facebook')
      for (const { rec } of this.#rows.values())
        if (
          rec.platform === 'facebook' &&
          rec.externalAccountId === i.externalAccountId &&
          rec.status !== 'revoked'
        )
          throw new ConnectionTakenError();
    const scope = {
      organizationId: i.organizationId,
      brandId: i.brandId,
      connectionId: randomUUID(),
    };
    this.#rows.set(scope.connectionId, {
      rec: {
        scope,
        platform: i.platform,
        externalAccountId: i.externalAccountId,
        status: 'reconnect_required',
      },
      reason: 'oauth_pending',
    });
    return { scope, created: true };
  }
  async activate(scope: ConnectionScope, actorUserId: string): Promise<boolean> {
    void actorUserId; // the Pg adapter records the actor; memory keeps no audit trail
    const row = this.#rows.get(scope.connectionId);
    // Same transitions as the Pg adapter: paused and revoked connections never activate.
    if (
      !row ||
      !sameScope(row.rec.scope, scope) ||
      !['active', 'reconnect_required', 'error'].includes(row.rec.status)
    )
      return false;
    this.#rows.set(scope.connectionId, { rec: { ...row.rec, status: 'active' }, reason: null });
    return true;
  }
  async findLiveByAccount(
    platform: Platform,
    externalAccountId: string,
  ): Promise<ConnectionRecord | null> {
    const live = [...this.#rows.values()].filter(
      ({ rec }) =>
        rec.platform === platform &&
        rec.externalAccountId === externalAccountId &&
        rec.status !== 'revoked',
    );
    return live.length === 1 ? live[0]!.rec : null;
  }
  async disconnect(scope: ConnectionScope, actorUserId: string): Promise<boolean> {
    void actorUserId; // the Pg adapter audits the actor; memory keeps no audit trail
    const row = this.#rows.get(scope.connectionId);
    if (!row || !sameScope(row.rec.scope, scope) || row.rec.status === 'revoked') return false;
    this.#rows.set(scope.connectionId, {
      rec: { ...row.rec, status: 'revoked' },
      reason: 'user_disconnected',
    });
    return true;
  }
}

export class MemoryCredentialVault implements CredentialVault {
  readonly #tokens = new Map<string, { access: TokenRecord | null; refresh: TokenRecord | null }>();
  readonly #failNext = new Set<'access' | 'refresh'>();

  failNextWrite(kind: 'access' | 'refresh'): void {
    this.#failNext.add(kind);
  }
  async readTokens(scope: ConnectionScope) {
    return this.#tokens.get(scopeKey(scope)) ?? { access: null, refresh: null };
  }
  async writeRefreshToken(scope: ConnectionScope, t: TokenRecord): Promise<void> {
    this.#write(scope, 'refresh', t);
  }
  async writeAccessToken(scope: ConnectionScope, t: TokenRecord): Promise<void> {
    this.#write(scope, 'access', t);
  }
  #write(scope: ConnectionScope, kind: 'access' | 'refresh', t: TokenRecord): void {
    if (this.#failNext.delete(kind)) throw new Error('simulated storage failure');
    const cur = this.#tokens.get(scopeKey(scope)) ?? { access: null, refresh: null };
    this.#tokens.set(scopeKey(scope), { ...cur, [kind]: t });
  }
}

export class MemoryRefreshLock implements RefreshLock {
  readonly #tails = new Map<string, Promise<unknown>>();
  async run<T>(scope: ConnectionScope, fn: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope);
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.#tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    }
  }
}

export class MemoryOAuthStateStore implements OAuthStateStore {
  readonly #rows = new Map<string, PendingAuthorization>();
  constructor(private readonly clock: Clock = systemClock) {}
  size(): number {
    return this.#rows.size;
  }
  async save(stateHash: Buffer, p: PendingAuthorization): Promise<void> {
    this.#rows.set(stateHash.toString('hex'), p);
  }
  async consume(stateHash: Buffer, b: StateBinding): Promise<PendingAuthorization | null> {
    const k = stateHash.toString('hex');
    const p = this.#rows.get(k);
    if (
      !p ||
      p.organizationId !== b.organizationId ||
      p.brandId !== b.brandId ||
      p.platform !== b.platform ||
      p.initiatedByUserId !== b.initiatedByUserId
    )
      return null;
    this.#rows.delete(k);
    return p;
  }
  async peekBinding(stateHash: Buffer): Promise<StateBinding | null> {
    const p = this.#rows.get(stateHash.toString('hex'));
    if (!p || p.expiresAt.getTime() <= this.clock.now()) return null;
    return {
      organizationId: p.organizationId,
      brandId: p.brandId,
      platform: p.platform,
      initiatedByUserId: p.initiatedByUserId,
    };
  }
}

export class MemoryOAuthGrantStore implements OAuthGrantStore {
  readonly #rows = new Map<string, PendingGrant>();
  constructor(private readonly clock: Clock = systemClock) {}

  async save(g: PendingGrant): Promise<void> {
    this.#rows.set(g.id, g);
  }
  async load(id: string, b: StateBinding): Promise<PendingGrant | null> {
    const g = this.#rows.get(id);
    if (
      !g ||
      g.organizationId !== b.organizationId ||
      g.brandId !== b.brandId ||
      g.platform !== b.platform ||
      g.initiatedByUserId !== b.initiatedByUserId ||
      g.expiresAt.getTime() <= this.clock.now()
    )
      return null;
    return g;
  }
  async consume(id: string, b: StateBinding): Promise<PendingGrant | null> {
    const g = await this.load(id, b);
    if (g) this.#rows.delete(id);
    return g;
  }
}

export class MemoryMembershipReader implements MembershipReader {
  readonly #roles = new Map<string, Role>();
  grant(organizationId: string, brandId: string, userId: string, role: Role): void {
    this.#roles.set(`${organizationId}/${brandId}/${userId}`, role);
  }
  async roleInBrand(organizationId: string, brandId: string, userId: string): Promise<Role | null> {
    return this.#roles.get(`${organizationId}/${brandId}/${userId}`) ?? null;
  }
}

export class MemoryDeliveryLedger implements DeliveryLedger {
  readonly #done = new Set<string>();
  readonly #running = new Map<string, Promise<void>>();
  async once(
    namespace: string,
    key: string,
    work: () => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    const k = `${namespace}\0${key}`;
    for (let inflight = this.#running.get(k); inflight; inflight = this.#running.get(k))
      await inflight.catch(() => undefined);
    if (this.#done.has(k)) return 'duplicate';
    const p = work();
    this.#running.set(k, p);
    try {
      await p;
      this.#done.add(k);
      return 'processed';
    } finally {
      this.#running.delete(k);
    }
  }
}

export class StaticWebhookSecrets implements WebhookSecretSource {
  constructor(
    private readonly app: ReadonlyMap<Platform, Secret>,
    private readonly perConnection: ReadonlyMap<
      string,
      { secret: Secret; externalAccountId: string; platform: Platform }
    > = new Map(),
  ) {}
  appSecret(platform: Platform): Secret | null {
    return this.app.get(platform) ?? null;
  }
  async connectionSecret(connectionId: string, platform: Platform) {
    const e = this.perConnection.get(connectionId);
    return e && e.platform === platform
      ? { secret: e.secret, externalAccountId: e.externalAccountId }
      : null;
  }
}

/** Keeps every recorded sync outcome, for assertions. */
export class MemorySyncRecorder implements SyncRecorder {
  readonly events: Array<{
    connectionId: string;
    kind: 'success' | 'failure';
    code?: string;
    errorClass?: ErrorClass;
  }> = [];

  async success(connectionId: string): Promise<void> {
    this.events.push({ connectionId, kind: 'success' });
  }

  async failure(
    connectionId: string,
    f: { readonly code: string; readonly errorClass: ErrorClass },
  ): Promise<void> {
    this.events.push({ connectionId, kind: 'failure', code: f.code, errorClass: f.errorClass });
  }
}
