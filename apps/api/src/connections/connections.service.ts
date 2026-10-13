import { Inject, Injectable } from '@nestjs/common';
import type { PgConnectorStack } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { parseUuidOr404 } from '../http/validation.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { CONNECTOR_STACK, DEPS, JOB_PRODUCER } from '../tokens.js';
import { enqueueLifecycle } from './lifecycle.js';

export type ConnectionViewStatus =
  | 'connected'
  | 'needs_reconnect'
  | 'disconnected'
  | 'paused'
  | 'error';

export interface ConnectionView {
  id: string;
  platform: string;
  displayName: string | null;
  externalAccountId: string;
  status: ConnectionViewStatus;
  /** A snake_case code; the web app maps it to text. */
  statusReason: string | null;
}

/** API status for a stored connection; null when it is not shown at all. */
export function viewStatus(status: string, reason: string | null): ConnectionViewStatus | null {
  switch (status) {
    case 'active':
      return 'connected';
    case 'reconnect_required':
      // An abandoned connect: the Page was chosen but never activated.
      return reason === 'oauth_pending' ? null : 'needs_reconnect';
    case 'revoked':
      return reason === 'user_disconnected' ? null : 'needs_reconnect';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(CONNECTOR_STACK) private readonly stack: PgConnectorStack | null,
    @Inject(JOB_PRODUCER) private readonly producer: JobProducer | null,
  ) {}

  async list(org: OrgContext, brandId: unknown): Promise<ConnectionView[]> {
    const brand = await requireBrand(this.deps.pool, org, brandId);
    const r = await this.deps.pool.query<{
      id: string;
      platform: string;
      display_name: string | null;
      external_account_id: string;
      status: string;
      status_reason: string | null;
    }>(
      `SELECT id, platform, display_name, external_account_id, status, status_reason
         FROM connection WHERE organization_id = $1 AND brand_id = $2
        ORDER BY created_at, id`,
      [brand.organizationId, brand.brandId],
    );
    const views: ConnectionView[] = [];
    for (const row of r.rows) {
      const status = viewStatus(row.status, row.status_reason);
      if (status === null) continue;
      views.push({
        id: row.id,
        platform: row.platform,
        displayName: row.display_name,
        externalAccountId: row.external_account_id,
        status,
        statusReason: status === 'connected' ? null : row.status_reason,
      });
    }
    return views;
  }

  /**
   * Revokes the connection locally, then queues the platform-side teardown
   * (which also deletes the stored credentials). Repeating it re-queues the
   * same teardown, which deduplicates; so a 503 here is safe to retry.
   */
  async disconnect(org: OrgContext, brandId: unknown, connectionId: unknown): Promise<void> {
    if (!this.stack || !this.producer) throw new ApiError(404, 'platform_not_configured');
    const brand = await requireBrand(this.deps.pool, org, brandId);
    const scope = { ...brand, connectionId: parseUuidOr404(connectionId) };
    const rec = await this.stack.directory.load(scope);
    if (!rec) throw notFound();
    await this.stack.directory.disconnect(scope, org.actorUserId);
    try {
      await enqueueLifecycle(this.deps.pool, this.producer, scope, rec.platform, 'teardown');
    } catch (err) {
      this.deps.log.error('connection teardown could not be queued', {
        connectionId: scope.connectionId,
        errorName: err instanceof Error ? err.name : 'NonError',
      });
      throw new ApiError(503, 'service_unavailable');
    }
  }
}
