import { Inject, Injectable } from '@nestjs/common';
import type { PgBackfillStore } from '@feedbouncer/comments';
import type { PgConnectorStack } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { parseUuidOr404 } from '../http/validation.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { BACKFILL_STORE, CONNECTOR_STACK, DEPS, JOB_PRODUCER } from '../tokens.js';
import { enqueueLifecycle } from './lifecycle.js';

export type ConnectionViewStatus =
  | 'connected'
  | 'needs_reconnect'
  | 'disconnected'
  | 'paused'
  | 'error';

export interface BackfillViewDto {
  status: 'pending' | 'running' | 'completed' | 'failed';
  importedCount: number;
  /** ISO time. */
  completedAt: string | null;
  limitedTo: number | null;
  nothingToImport: boolean;
  failureReason: string | null;
  skippedSources: number;
}

export interface ConnectionView {
  id: string;
  platform: string;
  displayName: string | null;
  externalAccountId: string;
  status: ConnectionViewStatus;
  /** A snake_case code; the web app maps it to text. */
  statusReason: string | null;
  backfill: BackfillViewDto | null;
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
      // Revoked is terminal: reconnecting cannot reopen it, only disconnecting
      // (then connecting again) can, so it is not offered as a reconnect.
      return reason === 'user_disconnected' ? null : 'error';
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
    @Inject(BACKFILL_STORE) private readonly backfill: PgBackfillStore,
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
    const bf = await this.backfill.views(brand, new Date());
    const views: ConnectionView[] = [];
    for (const row of r.rows) {
      const status = viewStatus(row.status, row.status_reason);
      if (status === null) continue;
      const v = bf.get(row.id);
      views.push({
        id: row.id,
        platform: row.platform,
        displayName: row.display_name,
        externalAccountId: row.external_account_id,
        status,
        statusReason: status === 'connected' ? null : row.status_reason,
        backfill: v
          ? {
              status: v.status,
              importedCount: v.importedCount,
              completedAt: v.completedAt?.toISOString() ?? null,
              limitedTo: v.limitedTo,
              nothingToImport: v.status === 'completed' && v.importedCount === 0,
              failureReason: v.failureReason,
              skippedSources: v.skippedCount,
            }
          : null,
      });
    }
    return views;
  }

  /**
   * Revokes the connection locally, then queues the platform-side teardown
   * (which also deletes the stored credentials). Repeating it on a connection
   * the user already disconnected re-queues the same teardown, which
   * deduplicates; so a 503 here is safe to retry. A row this call did not
   * disconnect for any other reason (a concurrent reconnect) is left alone.
   */
  async disconnect(org: OrgContext, brandId: unknown, connectionId: unknown): Promise<void> {
    if (!this.stack || !this.producer) throw new ApiError(404, 'platform_not_configured');
    const brand = await requireBrand(this.deps.pool, org, brandId);
    const scope = { ...brand, connectionId: parseUuidOr404(connectionId) };
    const rec = await this.stack.directory.load(scope);
    if (!rec) throw notFound();
    const disconnected = await this.stack.directory.disconnect(scope, org.actorUserId);
    if (!disconnected && !(await this.isUserDisconnected(scope))) return;
    try {
      await this.backfill.cancel(scope, new Date());
    } catch (err) {
      // The runtime refuses a revoked connection, so platform calls stop anyway.
      this.deps.log.warn('backfill cancel failed', {
        connectionId: scope.connectionId,
        errorName: err instanceof Error ? err.name : 'NonError',
      });
    }
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

  private async isUserDisconnected(scope: ConnectionScope): Promise<boolean> {
    const r = await this.deps.pool.query<{ status: string; status_reason: string | null }>(
      `SELECT status, status_reason FROM connection
        WHERE id = $3 AND organization_id = $1 AND brand_id = $2`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    );
    const row = r.rows[0];
    return row?.status === 'revoked' && row.status_reason === 'user_disconnected';
  }
}
