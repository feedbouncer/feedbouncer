// The Facebook connect flow: authorize, OAuth callback, Page selection and
// connect. OAuthFlow checks membership and connection.manage on every leg;
// this layer adds the path brand check, maps outcomes to HTTP, and enqueues
// the platform-side setup for every connected Page.
import { Inject, Injectable } from '@nestjs/common';
import { FACEBOOK_SCOPES } from '@feedbouncer/connector-facebook';
import {
  OAuthAccessDeniedError,
  assertAllowedUrl,
  type ConnectAccountResult,
  type GrantAccountView,
  type OAuthActor,
  type OAuthCompletion,
  type PgConnectorStack,
} from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { CONNECTOR_STACK, DEPS, JOB_PRODUCER } from '../tokens.js';
import { enqueueLifecycle } from './lifecycle.js';

const PLATFORM = 'facebook';
const AUTHORIZATION_HOSTS = ['www.facebook.com'];
const OWN_SCOPES: ReadonlySet<string> = new Set(FACEBOOK_SCOPES);

/** A web-app path for a callback outcome. Built from ids and fixed codes only, never from the query. */
export function callbackPath(actor: OAuthActor | null, c: OAuthCompletion): string {
  if (actor === null || (!c.ok && c.reason === 'rejected')) return '/orgs?error=oauth_rejected';
  const connections = `/orgs/${actor.organizationId}/brands/${actor.brandId}/connections`;
  if (c.ok)
    return c.kind === 'account_selection'
      ? `${connections}/facebook/select?grant=${c.grantId}`
      : connections;
  if (c.reason === 'missing_permissions') {
    const missing = c.missing.filter((s) => OWN_SCOPES.has(s)).join(',');
    return `${connections}?error=missing_permissions&missing=${missing}`;
  }
  return `${connections}?error=${c.reason}`;
}

@Injectable()
export class FacebookConnectService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(CONNECTOR_STACK) private readonly stack: PgConnectorStack | null,
    @Inject(JOB_PRODUCER) private readonly producer: JobProducer | null,
  ) {}

  #configured(): { stack: PgConnectorStack; producer: JobProducer } {
    if (!this.stack || !this.producer) throw new ApiError(404, 'platform_not_configured');
    return { stack: this.stack, producer: this.producer };
  }

  async #actor(org: OrgContext, brandId: unknown): Promise<OAuthActor> {
    const brand = await requireBrand(this.deps.pool, org, brandId);
    return { ...brand, userId: org.actorUserId };
  }

  async authorize(
    org: OrgContext,
    brandId: unknown,
    reconnectConnectionId: string | undefined,
  ): Promise<string> {
    const { stack } = this.#configured();
    const actor = await this.#actor(org, brandId);
    try {
      const { authorizationUrl } = await stack.oauth.start(
        actor,
        PLATFORM,
        reconnectConnectionId === undefined ? {} : { reconnectConnectionId },
      );
      return assertAllowedUrl(authorizationUrl, AUTHORIZATION_HOSTS).href;
    } catch (err) {
      // Not this brand's connection to reconnect.
      if (err instanceof OAuthAccessDeniedError) throw notFound();
      throw err;
    }
  }

  /** The absolute web-app URL to redirect the browser to. */
  async complete(userId: string, query: Readonly<Record<string, unknown>>): Promise<string> {
    const { stack } = this.#configured();
    const { actor, completion } = await stack.oauth.completeForUser(userId, PLATFORM, query);
    return new URL(callbackPath(actor, completion), this.deps.env.publicWebUrl).href;
  }

  async grantAccounts(
    org: OrgContext,
    brandId: unknown,
    grantId: string,
  ): Promise<readonly GrantAccountView[]> {
    const { stack } = this.#configured();
    const r = await stack.oauth.listGrantAccounts(
      await this.#actor(org, brandId),
      PLATFORM,
      grantId,
    );
    if (r.ok) return r.accounts;
    throw r.reason === 'platform_error' ? new ApiError(502, 'platform_error') : notFound();
  }

  async connect(
    org: OrgContext,
    brandId: unknown,
    grantId: string,
    pageIds: readonly string[],
  ): Promise<readonly ConnectAccountResult[]> {
    const { stack, producer } = this.#configured();
    const actor = await this.#actor(org, brandId);
    let r: Awaited<ReturnType<typeof stack.oauth.connectAccounts>>;
    try {
      r = await stack.oauth.connectAccounts(actor, PLATFORM, grantId, pageIds);
    } catch (err) {
      // A storage failure part-way through: report it by name only.
      this.deps.log.error('facebook connect failed', {
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
        await this.#afterConnect(producer, scope, res.wasReconnectRequired);
      } catch (err) {
        this.deps.log.error('facebook connect follow-up could not be queued', {
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
      failed.map((scope) => stack.directory.markReauthRequired(scope, 'oauth_access_rejected')),
    );
    throw new ApiError(503, 'service_unavailable');
  }

  async #afterConnect(
    producer: JobProducer,
    scope: ConnectionScope,
    wasReconnectRequired: boolean,
  ): Promise<void> {
    if (!(await enqueueLifecycle(this.deps.pool, producer, scope, PLATFORM, 'setup')))
      throw new Error('connection authorized without an audit record');
    // Work that failed while access was lost runs again with the new token.
    if (wasReconnectRequired)
      await producer.replay({
        organizationId: scope.organizationId,
        connectionId: scope.connectionId,
        reason: 'needs_reconnection',
        limit: 1000,
      });
  }
}
