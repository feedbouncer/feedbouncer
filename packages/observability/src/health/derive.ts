import type { Platform } from '@feedbouncer/connectors';
import type { ErrorClass } from '@feedbouncer/service-runtime';

export const HEALTH_STATUSES = [
  'pending_first_sync',
  'healthy',
  'degraded',
  'needs_reconnection',
  'disabled',
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface HealthPolicy {
  staleAfterMs(platform: Platform): number;
  readonly lagDegradedMs: number;
  readonly failuresDegraded: number;
  readonly firstSyncGraceMs: number;
}

export interface ConnectionFacts {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly brandId: string;
  readonly platform: Platform;
  readonly status: 'active' | 'paused' | 'revoked' | 'error' | 'reconnect_required';
  readonly statusReason: string | null;
  readonly createdAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorClass: ErrorClass | null;
  readonly consecutiveFailures: number;
  readonly oldestQueuedAt: Date | null;
  readonly accessTokenExpiresAt: Date | null;
  readonly hasAccessToken: boolean;
  readonly refreshTokenExpiresAt: Date | null;
  readonly hasRefreshToken: boolean;
}

export interface ConnectionHealth {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly brandId: string;
  readonly platform: Platform;
  readonly status: HealthStatus;
  readonly reason: string;
  readonly lastSuccessAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: Date | null;
  readonly consecutiveFailures: number;
  readonly stalenessMs: number | null;
  readonly ingestLagMs: number;
}

const age = (t: Date | null, now: Date): number | null =>
  t === null ? null : Math.max(0, now.getTime() - t.getTime());

/** Pure derivation; first matching rule wins (decision 7 of the observability plan). */
export function deriveConnectionHealth(
  f: ConnectionFacts,
  p: HealthPolicy,
  now: Date,
): ConnectionHealth {
  const stalenessMs = age(f.lastSuccessAt, now);
  const ingestLagMs = age(f.oldestQueuedAt, now) ?? 0;
  const out = (status: HealthStatus, reason: string): ConnectionHealth => ({
    connectionId: f.connectionId,
    organizationId: f.organizationId,
    brandId: f.brandId,
    platform: f.platform,
    status,
    reason,
    lastSuccessAt: f.lastSuccessAt,
    lastErrorCode: f.lastErrorCode,
    lastErrorAt: f.lastFailureAt,
    consecutiveFailures: f.consecutiveFailures,
    stalenessMs,
    ingestLagMs,
  });
  const expired = (t: Date | null) => t !== null && t.getTime() <= now.getTime();

  if (f.status === 'paused' || f.status === 'revoked') return out('disabled', f.status);
  if (f.status === 'reconnect_required') {
    return out('needs_reconnection', f.statusReason ?? 'reconnect_required');
  }
  if (
    f.hasAccessToken &&
    expired(f.accessTokenExpiresAt) &&
    (!f.hasRefreshToken || expired(f.refreshTokenExpiresAt))
  ) {
    return out('needs_reconnection', 'token_expired');
  }
  if (f.status === 'error') return out('degraded', f.statusReason ?? 'connection_error');
  const failing = f.consecutiveFailures >= p.failuresDegraded;
  if (f.lastSuccessAt === null) {
    if (failing) return out('degraded', 'recent_failures');
    if ((age(f.createdAt, now) ?? 0) > p.firstSyncGraceMs)
      return out('degraded', 'first_sync_overdue');
    return out('pending_first_sync', 'pending_first_sync');
  }
  if (failing) return out('degraded', 'recent_failures');
  if ((stalenessMs ?? 0) > p.staleAfterMs(f.platform)) return out('degraded', 'sync_stale');
  if (ingestLagMs > p.lagDegradedMs) return out('degraded', 'ingest_lag');
  return out('healthy', 'ok');
}
