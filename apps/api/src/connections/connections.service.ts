import { Inject, Injectable } from '@nestjs/common';
import { PgSuggestionStore } from '@feedbouncer/actions';
import type { PgBackfillStore } from '@feedbouncer/comments';
import {
  systemClock,
  type Platform,
  type PgConnectorStack,
  type ReviewMode,
} from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { parseUuidOr404 } from '../http/validation.js';
import { requireBrand, type BrandScope } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { BACKFILL_STORE, CONNECTOR_STACK, DEPS, JOB_PRODUCER } from '../tokens.js';
import { toReviewModeStatusDto, type ReviewModeStatusDto } from '../review-mode/dto.js';
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
  reviewMode: ReviewModeStatusDto;
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
  readonly #suggestions: PgSuggestionStore;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(CONNECTOR_STACK) private readonly stack: PgConnectorStack | null,
    @Inject(JOB_PRODUCER) private readonly producer: JobProducer | null,
    @Inject(BACKFILL_STORE) private readonly backfill: PgBackfillStore,
  ) {
    this.#suggestions = new PgSuggestionStore(deps.pool);
  }

  async list(org: OrgContext, brandId: unknown): Promise<ConnectionView[]> {
    const brand = await requireBrand(this.deps.pool, org, brandId);
    const now = new Date(systemClock.now());
    const [rows, bf, pending] = await Promise.all([
      this.#rows(brand),
      this.backfill.views(brand, now),
      this.#suggestions.pendingCounts(brand, now),
    ]);
    return rows.map((row) => {
      const v = bf.get(row.id);
      return {
        id: row.id,
        platform: row.platform,
        displayName: row.display_name,
        externalAccountId: row.external_account_id,
        status: row.view_status,
        statusReason: row.view_status === 'connected' ? null : row.status_reason,
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
        reviewMode: toReviewModeStatusDto(row.connection, pending.get(row.id) ?? 0, now),
      };
    });
  }

  /** Review-mode status of the brand's visible connections, without backfill details. */
  async reviewModes(org: OrgContext, brandId: unknown): Promise<ReviewModeStatusDto[]> {
    const brand = await requireBrand(this.deps.pool, org, brandId);
    const now = new Date(systemClock.now());
    const [rows, pending] = await Promise.all([
      this.#rows(brand),
      this.#suggestions.pendingCounts(brand, now),
    ]);
    return rows.map((row) => toReviewModeStatusDto(row.connection, pending.get(row.id) ?? 0, now));
  }

  /** The brand's connections that are visible to users, oldest first. */
  async #rows(brand: BrandScope) {
    const r = await this.deps.pool.query<{
      id: string;
      platform: Platform;
      display_name: string | null;
      external_account_id: string;
      status: string;
      status_reason: string | null;
      review_mode: ReviewMode;
      review_mode_started_at: Date | null;
      review_mode_ends_at: Date | null;
      review_mode_ended_at: Date | null;
    }>(
      `SELECT id, platform, display_name, external_account_id, status, status_reason, review_mode,
              review_mode_started_at, review_mode_ends_at, review_mode_ended_at
         FROM connection WHERE organization_id = $1 AND brand_id = $2
        ORDER BY created_at, id`,
      [brand.organizationId, brand.brandId],
    );
    return r.rows.flatMap((row) => {
      const viewStat = viewStatus(row.status, row.status_reason);
      if (viewStat === null) return [];
      return [
        {
          ...row,
          view_status: viewStat,
          connection: {
            id: row.id,
            platform: row.platform,
            displayName: row.display_name,
            review: {
              mode: row.review_mode,
              startedAt: row.review_mode_started_at,
              endsAt: row.review_mode_ends_at,
              endedAt: row.review_mode_ended_at,
            },
          },
        },
      ];
    });
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
