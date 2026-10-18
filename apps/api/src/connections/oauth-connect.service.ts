// The connect flow for platforms where the user picks accounts after consent
// (Facebook Pages, Instagram accounts): authorize, OAuth callback, account
// selection and connect. OAuthFlow checks membership and connection.manage on
// every leg; this layer adds the path brand check, maps outcomes to HTTP, and
// enqueues the platform-side setup for every connected account.
import { Inject, Injectable } from '@nestjs/common';
import {
  OAuthAccessDeniedError,
  assertAllowedUrl,
  type ConnectAccountResult,
  type GrantAccountView,
  type OAuthActor,
  type OAuthCompletion,
  type PgConnectorStack,
  type Platform,
} from '@feedbouncer/connectors';
import { enqueueLifecycle, type PgBackfillStore } from '@feedbouncer/comments';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { BACKFILL_STORE, CONNECTOR_STACK, DEPS, JOB_PRODUCER } from '../tokens.js';
import { requestBackfill } from './backfill.js';

/**
 * A web-app path for a callback outcome. Built from ids, fixed codes and the
 * platform's own scope names only, never from the query.
 */
export function callbackPath(
  target: { platform: Platform; scopes: readonly string[] },
  actor: OAuthActor | null,
  c: OAuthCompletion,
): string {
  if (actor === null || (!c.ok && c.reason === 'rejected')) return '/orgs?error=oauth_rejected';
  const connections = `/orgs/${actor.organizationId}/brands/${actor.brandId}/connections`;
  if (c.ok)
    return c.kind === 'account_selection'
      ? `${connections}/${target.platform}/select?grant=${c.grantId}`
      : connections;
  if (c.reason === 'missing_permissions') {
    const own = new Set(target.scopes);
    const missing = c.missing.filter((s) => own.has(s)).join(',');
    return `${connections}?error=missing_permissions&missing=${missing}`;
  }
  return `${connections}?error=${c.reason}`;
}

@Injectable()
export class OAuthConnectService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(CONNECTOR_STACK) private readonly stack: PgConnectorStack | null,
    @Inject(JOB_PRODUCER) private readonly producer: JobProducer | null,
    @Inject(BACKFILL_STORE) private readonly backfill: PgBackfillStore,
  ) {}

  #configured(): { stack: PgConnectorStack; producer: JobProducer } {
    if (!this.stack || !this.producer) throw new ApiError(404, 'platform_not_configured');
    return { stack: this.stack, producer: this.producer };
  }

  /** Scopes and authorization hosts come from the connector, so each platform keeps its own. The route's pipe has checked it is registered. */
  #capabilities(platform: Platform) {
    return this.deps.connectors!.registry.require(platform).capabilities;
  }

  async #actor(org: OrgContext, brandId: unknown): Promise<OAuthActor> {
    const brand = await requireBrand(this.deps.pool, org, brandId);
    return { ...brand, userId: org.actorUserId };
  }

  async authorize(
    platform: Platform,
    org: OrgContext,
    brandId: unknown,
    reconnectConnectionId: string | undefined,
  ): Promise<string> {
    const { stack } = this.#configured();
    const { authorizationHosts } = this.#capabilities(platform);
    const actor = await this.#actor(org, brandId);
    try {
      const { authorizationUrl } = await stack.oauth.start(
        actor,
        platform,
        reconnectConnectionId === undefined ? {} : { reconnectConnectionId },
      );
      return assertAllowedUrl(authorizationUrl, authorizationHosts).href;
    } catch (err) {
      // Not this brand's connection to reconnect.
      if (err instanceof OAuthAccessDeniedError) throw notFound();
      throw err;
    }
  }

  /** The absolute web-app URL to redirect the browser to. */
  async complete(
    platform: Platform,
    userId: string,
    query: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const { stack } = this.#configured();
    const { actor, completion } = await stack.oauth.completeForUser(userId, platform, query);
    const target = { platform, scopes: this.#capabilities(platform).defaultScopes };
    return new URL(callbackPath(target, actor, completion), this.deps.env.publicWebUrl).href;
  }

  async grantAccounts(
    platform: Platform,
    org: OrgContext,
    brandId: unknown,
    grantId: string,
  ): Promise<readonly GrantAccountView[]> {
    const { stack } = this.#configured();
    const r = await stack.oauth.listGrantAccounts(
      await this.#actor(org, brandId),
      platform,
      grantId,
    );
    if (r.ok) return r.accounts;
    throw r.reason === 'platform_error' ? new ApiError(502, 'platform_error') : notFound();
  }

  async connect(
    platform: Platform,
    org: OrgContext,
    brandId: unknown,
    grantId: string,
    accountIds: readonly string[],
    opts: { reviewMode: 'on' | 'opted_out' },
  ): Promise<readonly ConnectAccountResult[]> {
    const { stack, producer } = this.#configured();
    const actor = await this.#actor(org, brandId);
    let r: Awaited<ReturnType<typeof stack.oauth.connectAccounts>>;
    try {
      r = await stack.oauth.connectAccounts(actor, platform, grantId, accountIds, opts);
    } catch (err) {
      // A storage failure part-way through: report it by name only.
      this.deps.log.error('oauth connect failed', {
        platform,
        organizationId: actor.organizationId,
        brandId: actor.brandId,
        errorName: err instanceof Error ? err.name : 'NonError',
      });
      throw new ApiError(500, 'internal_error');
    }
    if (!r.ok)
      throw r.reason === 'platform_error' ? new ApiError(502, 'platform_error') : notFound();

    const failed: ConnectionScope[] = [];
    for (const res of r.results) {
      if (res.connectionId === null) continue;
      if (res.status !== 'connected' && res.status !== 'reconnected') continue;
      const scope: ConnectionScope = {
        organizationId: actor.organizationId,
        brandId: actor.brandId,
        connectionId: res.connectionId,
      };
      try {
        await this.#afterConnect(producer, platform, scope, res.wasReconnectRequired);
      } catch (err) {
        this.deps.log.error('oauth connect follow-up could not be queued', {
          platform,
          organizationId: actor.organizationId,
          brandId: actor.brandId,
          errorName: err instanceof Error ? err.name : 'NonError',
        });
        failed.push(scope);
      }
    }
    if (failed.length === 0) return r.results;
    // The grant is spent, so a retry cannot run setup again. Reconnecting can.
    await Promise.all(
      failed.map((scope) => stack.directory.markReauthRequired(scope, 'setup_not_queued')),
    );
    throw new ApiError(503, 'service_unavailable');
  }

  async #afterConnect(
    producer: JobProducer,
    platform: Platform,
    scope: ConnectionScope,
    wasReconnectRequired: boolean,
  ): Promise<void> {
    if (!(await enqueueLifecycle(this.deps.pool, producer, scope, platform, 'setup')))
      throw new Error('connection authorized without an audit record');
    // Work that failed while access was lost runs again with the new token.
    if (wasReconnectRequired)
      await producer.replay({
        organizationId: scope.organizationId,
        connectionId: scope.connectionId,
        reason: 'needs_reconnection',
        limit: 1000,
      });
    await requestBackfill(this.backfill, producer, scope, platform, new Date());
  }
}
