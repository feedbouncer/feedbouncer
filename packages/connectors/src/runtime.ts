// The only API the moderation core uses. Every platform call goes through
// #call: connection status check -> budget -> access token -> connector op
// (with timeout) -> one refresh-and-retry on a rejected token -> platform
// rate hints fed back into the budget. Output is validated before return.
// Failures are attributed: a foreign error from the connector is replaced by
// permanent/connector_failure; a foreign error from a port (directory, vault,
// lock, budget store) is an outage, reported as transient/storage_unavailable
// so the caller retries instead of dropping the work.
import { trace } from '@opentelemetry/api';
import type { ConnectionScope } from '@feedbouncer/secrets';
import {
  SpanKind,
  setSpanAttributes,
  withSpan,
  type Logger,
  type Secret,
} from '@feedbouncer/service-runtime';
import type { RateBudget } from './budget.js';
import type { Clock } from './clock.js';
import type { CallContext, Connector } from './connector.js';
import {
  ConnectorError,
  errorClassFor,
  toConnectorError,
  type ConnectorErrorKind,
} from './errors.js';
import type { SafeHttp } from './http.js';
import {
  recordSync,
  type ConnectionDirectory,
  type ConnectionRecord,
  type CredentialVault,
  type SyncRecorder,
} from './ports.js';
import type { ConnectorRegistry } from './registry.js';
import { scopeKey } from './scope.js';
import {
  actionRequestSchema,
  commentRefSchema,
  commentSchema,
  cursorSchema,
  externalIdSchema,
  parseComment,
  parsePage,
  respondRequestSchema,
  sourceSchema,
} from './schemas.js';
import type { TokenManager } from './tokens.js';
import {
  INVERSE_ACTION,
  type ActionRequest,
  type ActionResult,
  type CommentRef,
  type ConnectorCapabilities,
  type ModerationAction,
  type NormalizedComment,
  type NormalizedSource,
  type Page,
  type Platform,
  type Priority,
  type RespondRequest,
  type RespondResult,
  type ResponseKind,
} from './types.js';

export type ConnectorOperation =
  | 'list_sources'
  | 'list_comments'
  | 'get_comment'
  | 'act'
  | 'respond'
  | 'lifecycle';
export interface ConnectorCallEvent {
  readonly platform: Platform;
  readonly operation: ConnectorOperation;
  readonly outcome: 'ok' | ConnectorErrorKind;
  readonly durationMs: number;
}
/** Receives one event per platform call. Must not throw; exceptions are swallowed. */
export interface ConnectorCallObserver {
  onCall(e: ConnectorCallEvent): void;
}

export interface RuntimeDeps {
  registry: ConnectorRegistry;
  directory: ConnectionDirectory;
  /** Needed only by `teardown`, which reads tokens of revoked connections directly. */
  vault?: CredentialVault;
  tokens: TokenManager;
  budget: RateBudget;
  clock: Clock;
  log: Logger;
  http(connector: Connector): SafeHttp;
  callTimeoutMs?: number;
  observer?: ConnectorCallObserver;
  sync?: SyncRecorder;
}

export class ConnectorRuntime {
  constructor(private readonly d: RuntimeDeps) {}

  async connect(scope: ConnectionScope): Promise<ConnectionClient> {
    const rec = await viaPort(this.d.log, { connectionId: scope.connectionId }, () =>
      this.d.directory.load(scope),
    );
    if (!rec) throw new ConnectorError('not_found', 'connection_not_found');
    return new ConnectionClient(this.d, this.d.registry.require(rec.platform), scope);
  }

  /**
   * Platform-side cleanup after a local disconnect, then removal of the stored
   * credentials. Runs only on revoked connections; reads the access token
   * straight from the vault (no refresh, no status check, no budget).
   * Credentials are kept only when the platform call fails retryably, so the
   * caller's retry can finish the cleanup.
   */
  async teardown(scope: ConnectionScope): Promise<'done' | 'no_token' | 'no_lifecycle'> {
    const vault = this.d.vault;
    if (!vault) throw new ConnectorError('permanent', 'teardown_unavailable');
    const fields = { connectionId: scope.connectionId };
    const rec = await viaPort(this.d.log, fields, () => this.d.directory.load(scope));
    if (!rec) throw new ConnectorError('not_found', 'connection_not_found');
    if (rec.status !== 'revoked') throw new ConnectorError('permanent', 'connection_not_revoked');
    const connector = this.d.registry.require(rec.platform);
    const forget = () => viaPort(this.d.log, fields, () => vault.deleteTokens(scope));
    const lifecycle = connector.lifecycle;
    if (!lifecycle) {
      await forget();
      return 'no_lifecycle';
    }
    const { access } = await viaPort(this.d.log, fields, () => vault.readTokens(scope));
    if (!access) {
      await forget();
      return 'no_token';
    }
    try {
      await lifecycle.onDisconnected({
        accessToken: access.value,
        externalAccountId: rec.externalAccountId,
        http: this.d.http(connector),
        signal: AbortSignal.timeout(this.d.callTimeoutMs ?? 15_000),
        reportQuota: async () => {},
      });
    } catch (err) {
      const ce = toConnectorError(err);
      this.d.log.warn('connector teardown failed', {
        platform: rec.platform,
        connectionId: scope.connectionId,
        kind: ce.kind,
        errorCode: ce.code,
        ...(ce === err ? {} : { errorName: errorName(err) }),
      });
      if (ce.kind !== 'transient' && ce.kind !== 'rate_limited') await forget();
      throw ce;
    }
    await forget();
    return 'done';
  }
}

const SNAKE_CODE = /^[a-z][a-z0-9_]{0,62}$/;
const invalidRequest = () => new ConnectorError('permanent', 'invalid_request');
const errorName = (err: unknown) => (err instanceof Error ? err.name : 'NonError');

/** Runs a port call; a foreign error is an outage, logged by name only. */
async function viaPort<T>(
  log: Logger,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    log.warn('connection storage unavailable', { ...fields, errorName: errorName(err) });
    throw new ConnectorError('transient', 'storage_unavailable');
  }
}

export class ConnectionClient {
  readonly platform: Platform;
  readonly capabilities: ConnectorCapabilities;

  constructor(
    private readonly d: RuntimeDeps,
    private readonly connector: Connector,
    private readonly scope: ConnectionScope,
  ) {
    this.platform = connector.platform;
    this.capabilities = connector.capabilities;
  }

  supports(action: ModerationAction): boolean {
    return this.capabilities.actions.includes(action);
  }

  supportsResponse(kind: ResponseKind): boolean {
    return (
      (this.capabilities.responses ?? []).includes(kind) &&
      typeof this.connector.respond === 'function'
    );
  }

  async listSources(cursor: string | null): Promise<Page<NormalizedSource>> {
    const op = this.connector.listSources?.bind(this.connector);
    if (!op) throw new ConnectorError('unsupported', 'list_sources');
    if (!cursorSchema.safeParse(cursor).success) throw invalidRequest();
    return parsePage(
      sourceSchema,
      await this.#call('bulk', 'list_sources', (ctx) => op(ctx, { cursor })),
    );
  }

  async listComments(req: {
    sourceExternalId: string;
    cursor: string | null;
    limit?: number;
  }): Promise<Page<NormalizedComment>> {
    if (
      !externalIdSchema.safeParse(req.sourceExternalId).success ||
      !cursorSchema.safeParse(req.cursor).success
    )
      throw invalidRequest();
    const max = this.capabilities.maxPageSize;
    const limit = Math.min(Math.max(Math.trunc(req.limit ?? max), 1), max);
    const raw = await this.#call('bulk', 'list_comments', (ctx) =>
      this.connector.listComments(ctx, {
        sourceExternalId: req.sourceExternalId,
        cursor: req.cursor,
        limit,
      }),
    );
    return parsePage(commentSchema, raw);
  }

  async getComment(ref: CommentRef): Promise<NormalizedComment | null> {
    if (!commentRefSchema.safeParse(ref).success) throw invalidRequest();
    try {
      const raw = await this.#call('bulk', 'get_comment', (ctx) =>
        this.connector.getComment(ctx, ref),
      );
      return raw === null ? null : parseComment(raw);
    } catch (err) {
      if (
        err instanceof ConnectorError &&
        err.kind === 'not_found' &&
        err.code !== 'connection_not_found'
      )
        return null;
      throw err;
    }
  }

  /** Never throws for platform outcomes; they are encoded in the result. */
  act(req: ActionRequest): Promise<ActionResult> {
    return withSpan(
      'moderation.apply',
      { attributes: { 'feedbouncer.platform': this.platform, 'feedbouncer.action': req.action } },
      async (span) => {
        const result = await this.#actInner(req);
        setSpanAttributes(span, {
          'feedbouncer.action.status': result.status,
          'feedbouncer.action.reversible': result.status === 'applied' && result.undo !== null,
          'feedbouncer.error.code': result.status === 'failed' ? result.error.code : null,
        });
        // Failures are recorded here, not in #call: #actInner turns thrown errors into results.
        // A rejected request and an exhausted local budget say nothing about platform health.
        if (
          result.status === 'failed' &&
          result.error.code !== 'budget_exhausted' &&
          result.error.code !== 'invalid_action_request'
        ) {
          const e = result.error;
          const errorClass = errorClassFor(e.kind, e.reauthorize);
          const ids = this.#ids();
          recordSync(this.d.sync, this.d.log, ids, (s) =>
            s.failure(ids.connectionId, { code: e.code, errorClass }),
          );
        }
        return result;
      },
    );
  }

  async #actInner(req: ActionRequest): Promise<ActionResult> {
    if (!actionRequestSchema.safeParse(req).success)
      return {
        status: 'failed',
        request: req,
        error: new ConnectorError('permanent', 'invalid_action_request').info(),
      };
    if (!this.supports(req.action)) return { status: 'unsupported', request: req };
    try {
      const out = await this.#call('urgent', 'act', (ctx) => this.connector.act(ctx, req));
      if (out?.status === 'not_found') return { status: 'not_found', request: req };
      if (out?.status !== 'applied')
        throw new ConnectorError('permanent', 'invalid_connector_output');
      const inverse = INVERSE_ACTION[req.action];
      const pid =
        typeof out.platformActionId === 'string' &&
        externalIdSchema.safeParse(out.platformActionId).success
          ? out.platformActionId
          : null;
      return {
        status: 'applied',
        request: req,
        platformActionId: pid,
        undo: inverse && this.supports(inverse) ? { action: inverse, target: req.target } : null,
      };
    } catch (err) {
      const ce = toConnectorError(err);
      if (ce.kind === 'not_found' && ce.code !== 'connection_not_found')
        return { status: 'not_found', request: req };
      if (ce.kind === 'unsupported') return { status: 'unsupported', request: req };
      return { status: 'failed', request: req, error: ce.info() };
    }
  }

  /** Never throws for platform outcomes; they are encoded in the result. Runs at urgent priority. */
  respond(req: RespondRequest): Promise<RespondResult> {
    return withSpan(
      'moderation.respond',
      { attributes: { 'feedbouncer.platform': this.platform, 'feedbouncer.action': req.kind } },
      async (span) => {
        const result = await this.#respondInner(req);
        setSpanAttributes(span, {
          'feedbouncer.action.status': result.status,
          'feedbouncer.error.code':
            result.status === 'failed'
              ? result.error.code
              : result.status === 'not_eligible'
                ? result.code
                : null,
        });
        // As in act(): failures are recorded here because #respondInner turns throws into results.
        if (
          result.status === 'failed' &&
          result.error.code !== 'budget_exhausted' &&
          result.error.code !== 'invalid_respond_request'
        ) {
          const e = result.error;
          const ids = this.#ids();
          recordSync(this.d.sync, this.d.log, ids, (s) =>
            s.failure(ids.connectionId, {
              code: e.code,
              errorClass: errorClassFor(e.kind, e.reauthorize),
            }),
          );
        }
        return result;
      },
    );
  }

  async #respondInner(raw: RespondRequest): Promise<RespondResult> {
    const parsed = respondRequestSchema.safeParse(raw);
    if (!parsed.success)
      return {
        status: 'failed',
        request: raw,
        error: new ConnectorError('permanent', 'invalid_respond_request').info(),
      };
    const req = parsed.data;
    if (!this.supportsResponse(req.kind)) return { status: 'unsupported', request: req };
    const respond = this.connector.respond!.bind(this.connector);
    try {
      const out = await this.#call('urgent', 'respond', (ctx) => respond(ctx, req));
      if (out?.status === 'not_found') return { status: 'not_found', request: req };
      if (out?.status === 'not_eligible') {
        if (typeof out.code !== 'string' || !SNAKE_CODE.test(out.code))
          throw new ConnectorError('permanent', 'invalid_connector_output');
        return { status: 'not_eligible', request: req, code: out.code };
      }
      if (out?.status !== 'sent') throw new ConnectorError('permanent', 'invalid_connector_output');
      const ref =
        typeof out.platformRef === 'string' && externalIdSchema.safeParse(out.platformRef).success
          ? out.platformRef
          : null;
      return { status: 'sent', request: req, platformRef: ref };
    } catch (err) {
      const ce = toConnectorError(err);
      if (ce.kind === 'not_found' && ce.code !== 'connection_not_found')
        return { status: 'not_found', request: req };
      if (ce.kind === 'unsupported') return { status: 'unsupported', request: req };
      return { status: 'failed', request: req, error: ce.info() };
    }
  }

  /** Calls `lifecycle.onConnected`; a no-op without a lifecycle. Errors propagate. */
  async setup(): Promise<void> {
    const lc = this.connector.lifecycle;
    if (!lc) return;
    await this.#call('urgent', 'lifecycle', (ctx) => lc.onConnected(ctx));
  }

  /** Foreign errors are replaced, never wrapped; only the error name is logged. */
  #replace(err: unknown): ConnectorError {
    const ce = toConnectorError(err);
    if (ce !== err)
      this.d.log.warn('connector threw a non-ConnectorError', {
        ...this.#ids(),
        errorName: errorName(err),
      });
    return ce;
  }

  #ids() {
    return { platform: this.platform, connectionId: this.scope.connectionId };
  }

  #port<T>(fn: () => Promise<T>): Promise<T> {
    return viaPort(this.d.log, this.#ids(), fn);
  }

  async #call<T>(
    priority: Priority,
    operation: ConnectorOperation,
    op: (ctx: CallContext) => Promise<T>,
  ): Promise<T> {
    const ids = this.#ids();
    return withSpan(
      `connector.${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'feedbouncer.platform': ids.platform,
          'feedbouncer.connector.id': ids.connectionId,
          'feedbouncer.connector.operation': operation,
          'feedbouncer.connector.priority': priority,
        },
      },
      async () => {
        const started = performance.now();
        try {
          const out = await this.#callInner(priority, op);
          this.#observe(operation, 'ok', started);
          if (operation !== 'act' && operation !== 'respond')
            recordSync(this.d.sync, this.d.log, ids, (s) => s.success(ids.connectionId));
          return out;
        } catch (err) {
          const ce = err instanceof ConnectorError ? err : null;
          this.#observe(operation, ce?.kind ?? 'permanent', started);
          if (ce && operation !== 'act' && operation !== 'respond') {
            if (ce.kind === 'not_found' && ce.code !== 'connection_not_found') {
              // The platform answered: a missing comment or source is not a sync failure.
              recordSync(this.d.sync, this.d.log, ids, (s) => s.success(ids.connectionId));
            } else if (ce.code !== 'budget_exhausted') {
              recordSync(this.d.sync, this.d.log, ids, (s) =>
                s.failure(ids.connectionId, { code: ce.code, errorClass: ce.errorClass }),
              );
            }
          }
          throw err;
        }
      },
    );
  }

  #observe(
    operation: ConnectorOperation,
    outcome: 'ok' | ConnectorErrorKind,
    started: number,
  ): void {
    try {
      this.d.observer?.onCall({
        platform: this.platform,
        operation,
        outcome,
        durationMs: performance.now() - started,
      });
    } catch {
      /* telemetry never fails a call */
    }
  }

  async #callInner<T>(priority: Priority, op: (ctx: CallContext) => Promise<T>): Promise<T> {
    const rec = await this.#port(() => this.d.directory.load(this.scope));
    if (!rec) throw new ConnectorError('not_found', 'connection_not_found');
    if (rec.status === 'revoked')
      // terminal: cannot be fixed by re-authorizing
      throw new ConnectorError('auth_expired', 'connection_revoked', { reauthorize: false });
    if (rec.status === 'reconnect_required')
      throw new ConnectorError('auth_expired', 'reauthorization_required', { reauthorize: true });
    if (rec.status !== 'active') throw new ConnectorError('permanent', 'connection_inactive');

    const policy = this.capabilities.rateLimit;
    const key = scopeKey(this.scope);
    let rejected: Secret | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const decision = await this.#port(() =>
        this.d.budget.acquire(this.platform, key, policy, priority),
      );
      if (!decision.granted)
        throw new ConnectorError('rate_limited', 'budget_exhausted', {
          retryAfterMs: decision.retryAfterMs,
        });
      // TokenManager maps connector refresh failures itself; anything foreign is a port failure.
      const token = await this.#port(() =>
        this.d.tokens.accessToken(this.connector, this.scope, rejected ? { rejected } : {}),
      );
      try {
        return await op(this.#ctx(rec, token));
      } catch (err) {
        const ce = this.#replace(err);
        if (ce.kind === 'rate_limited') {
          const retryAfterMs = ce.retryAfterMs ?? policy.defaultRetryAfterMs;
          await this.#port(() =>
            this.d.budget.applyPlatformHint(this.platform, key, policy, { retryAfterMs }),
          );
          throw new ConnectorError('rate_limited', ce.code, { retryAfterMs });
        }
        if (ce.kind === 'auth_expired' && !ce.reauthorize) {
          if (attempt === 0) {
            rejected = token;
            trace.getActiveSpan()?.addEvent('connector.retry_with_refreshed_token');
            continue;
          }
          await this.#port(() =>
            this.d.directory.markReauthRequired(this.scope, 'oauth_access_rejected'),
          );
          throw new ConnectorError('auth_expired', 'oauth_access_rejected', { reauthorize: true });
        }
        throw ce;
      }
    }
    throw new ConnectorError('permanent', 'unreachable');
  }

  #ctx(rec: ConnectionRecord, token: Secret): CallContext {
    const policy = this.capabilities.rateLimit;
    return {
      accessToken: token,
      externalAccountId: rec.externalAccountId,
      http: this.d.http(this.connector),
      signal: AbortSignal.timeout(this.d.callTimeoutMs ?? 15_000),
      // Best-effort: a quota report never fails the connector's call.
      reportQuota: async (q) => {
        try {
          await this.d.budget.applyQuotaReport(
            this.platform,
            scopeKey(this.scope),
            policy,
            q,
            this.d.clock.now(),
          );
        } catch (err) {
          this.d.log.warn('quota report not applied', {
            ...this.#ids(),
            errorName: errorName(err),
          });
        }
      },
    };
  }
}

export function isSuccessEquivalent(r: ActionResult): boolean {
  return r.status === 'applied' || (r.status === 'not_found' && r.request.action === 'delete');
}
