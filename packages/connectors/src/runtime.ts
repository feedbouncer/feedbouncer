// The only API the moderation core uses. Every platform call goes through
// #call: connection status check -> budget -> access token -> connector op
// (with timeout) -> one refresh-and-retry on a rejected token -> platform
// rate hints fed back into the budget. Output is validated before return.
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger, Secret } from '@feedbouncer/service-runtime';
import type { RateBudget } from './budget.js';
import type { Clock } from './clock.js';
import type { CallContext, Connector } from './connector.js';
import { ConnectorError, toConnectorError } from './errors.js';
import type { SafeHttp } from './http.js';
import type { ConnectionDirectory, ConnectionRecord } from './ports.js';
import type { ConnectorRegistry } from './registry.js';
import {
  actionRequestSchema,
  commentRefSchema,
  commentSchema,
  cursorSchema,
  externalIdSchema,
  parseComment,
  parsePage,
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
} from './types.js';

export interface RuntimeDeps {
  registry: ConnectorRegistry;
  directory: ConnectionDirectory;
  tokens: TokenManager;
  budget: RateBudget;
  clock: Clock;
  log: Logger;
  http(connector: Connector): SafeHttp;
  callTimeoutMs?: number;
}

export class ConnectorRuntime {
  constructor(private readonly d: RuntimeDeps) {}

  async connect(scope: ConnectionScope): Promise<ConnectionClient> {
    const rec = await this.d.directory.load(scope);
    if (!rec) throw new ConnectorError('not_found', 'connection_not_found');
    return new ConnectionClient(this.d, this.d.registry.require(rec.platform), scope);
  }
}

const invalidRequest = () => new ConnectorError('permanent', 'invalid_request');

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

  async listSources(cursor: string | null): Promise<Page<NormalizedSource>> {
    const op = this.connector.listSources?.bind(this.connector);
    if (!op) throw new ConnectorError('unsupported', 'list_sources');
    if (!cursorSchema.safeParse(cursor).success) throw invalidRequest();
    return parsePage(sourceSchema, await this.#call('bulk', (ctx) => op(ctx, { cursor })));
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
    const raw = await this.#call('bulk', (ctx) =>
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
      const raw = await this.#call('bulk', (ctx) => this.connector.getComment(ctx, ref));
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
  async act(req: ActionRequest): Promise<ActionResult> {
    if (!actionRequestSchema.safeParse(req).success)
      return {
        status: 'failed',
        request: req,
        error: new ConnectorError('permanent', 'invalid_action_request').info(),
      };
    if (!this.supports(req.action)) return { status: 'unsupported', request: req };
    try {
      const out = await this.#call('urgent', (ctx) => this.connector.act(ctx, req));
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

  async #call<T>(priority: Priority, op: (ctx: CallContext) => Promise<T>): Promise<T> {
    try {
      return await this.#attempt(priority, op);
    } catch (err) {
      throw this.#replace(err);
    }
  }

  /** Foreign errors are replaced, never wrapped; only the error name is logged. */
  #replace(err: unknown): ConnectorError {
    const ce = toConnectorError(err);
    if (ce !== err)
      this.d.log.warn('connector threw a non-ConnectorError', {
        platform: this.platform,
        connectionId: this.scope.connectionId,
        errorName: err instanceof Error ? err.name : 'NonError',
      });
    return ce;
  }

  async #attempt<T>(priority: Priority, op: (ctx: CallContext) => Promise<T>): Promise<T> {
    const rec = await this.d.directory.load(this.scope);
    if (!rec) throw new ConnectorError('not_found', 'connection_not_found');
    if (rec.status === 'reconnect_required' || rec.status === 'revoked')
      throw new ConnectorError('auth_expired', 'reauthorization_required', { reauthorize: true });
    if (rec.status !== 'active') throw new ConnectorError('permanent', 'connection_inactive');

    const policy = this.capabilities.rateLimit;
    let rejected: Secret | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const decision = await this.d.budget.acquire(
        this.platform,
        this.scope.connectionId,
        policy,
        priority,
      );
      if (!decision.granted)
        throw new ConnectorError('rate_limited', 'budget_exhausted', {
          retryAfterMs: decision.retryAfterMs,
        });
      const token = await this.d.tokens.accessToken(
        this.connector,
        this.scope,
        rejected ? { rejected } : {},
      );
      try {
        return await op(this.#ctx(rec, token));
      } catch (err) {
        const ce = this.#replace(err);
        if (ce.kind === 'rate_limited') {
          const retryAfterMs = ce.retryAfterMs ?? policy.defaultRetryAfterMs;
          await this.d.budget.applyPlatformHint(this.platform, this.scope.connectionId, policy, {
            retryAfterMs,
          });
          throw new ConnectorError('rate_limited', ce.code, { retryAfterMs });
        }
        if (ce.kind === 'auth_expired' && !ce.reauthorize) {
          if (attempt === 0) {
            rejected = token;
            continue;
          }
          await this.d.directory.markReauthRequired(this.scope, 'oauth_access_rejected');
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
      reportQuota: (q) =>
        this.d.budget.applyQuotaReport(
          this.platform,
          this.scope.connectionId,
          policy,
          q,
          this.d.clock.now(),
        ),
    };
  }
}

export function isSuccessEquivalent(r: ActionResult): boolean {
  return r.status === 'applied' || (r.status === 'not_found' && r.request.action === 'delete');
}
