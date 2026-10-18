import { Inject, Injectable } from '@nestjs/common';
import { HEALTH_REASONS, type HealthStatus } from '@feedbouncer/observability';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';

export interface ConnectionHealthView {
  connectionId: string;
  platform: string;
  status: HealthStatus;
  reason: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  stalenessSeconds: number | null;
  ingestLagSeconds: number;
  failedImports: number;
}

// Anything outside the health vocabulary (a stored free-form reason) is not echoed.
const KNOWN_REASONS: ReadonlySet<string> = new Set(HEALTH_REASONS);

/** Maps a stored or derived reason to a bounded, non-sensitive vocabulary. */
export function boundedReason(status: HealthStatus, raw: string): string {
  if (KNOWN_REASONS.has(raw)) return raw;
  if (raw.startsWith('credential_')) return 'credential_unavailable';
  return status === 'needs_reconnection' ? 'reconnect_required' : 'connection_error';
}

@Injectable()
export class ConnectionHealthService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  async list(org: OrgContext, brandId: string): Promise<ConnectionHealthView[]> {
    // The brand must belong to the path organization: a brand of another
    // organization is indistinguishable from a missing one.
    const brand = await this.deps.pool.query(
      'SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2',
      [org.organizationId, brandId],
    );
    if (brand.rowCount === 0) throw notFound();
    const rows = await this.deps.health.forBrand(org.organizationId, brandId);
    return rows.map((h) => ({
      connectionId: h.connectionId,
      platform: h.platform,
      status: h.status,
      reason: boundedReason(h.status, h.reason),
      lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
      lastErrorCode: h.lastErrorCode,
      lastErrorAt: h.lastErrorAt?.toISOString() ?? null,
      consecutiveFailures: h.consecutiveFailures,
      stalenessSeconds: h.stalenessMs === null ? null : Math.floor(h.stalenessMs / 1000),
      ingestLagSeconds: Math.floor(h.ingestLagMs / 1000),
      failedImports: h.failedImports,
    }));
  }
}
