import { REAUTH_REASONS, type Platform } from '@feedbouncer/connectors';

export const HEALTH_STATUSES = [
  'pending_first_sync',
  'healthy',
  'degraded',
  'needs_reconnection',
  'disabled',
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/**
 * Every reason a connection can report: set by the rules in deriveConnectionHealth, or
 * written to the connection's status reason by the connector framework.
 */
export const HEALTH_REASONS = [
  'ok',
  'pending_first_sync',
  'recent_failures',
  'sync_stale',
  'ingest_lag',
  'token_expired',
  'paused',
  'revoked',
  'connection_error',
  'reconnect_required',
  'oauth_pending',
  ...REAUTH_REASONS,
] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];

export interface HealthPolicy {
  staleAfterMs(platform: Platform): number;
  readonly lagDegradedMs: number;
  readonly failuresDegraded: number;
}

export interface ConnectionFacts {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly brandId: string;
  readonly platform: Platform;
  readonly status: 'active' | 'paused' | 'revoked' | 'error' | 'reconnect_required';
  readonly statusReason: string | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastErrorCode: string | null;
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

/**
 * Pure derivation; the first matching rule wins: disabled (paused or revoked), needs
 * reconnection (flagged, or tokens expired with no usable refresh), degraded (connection
 * error, repeated failures, stale sync, ingest lag), then pending
 * first sync or healthy.
 */
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
    return out('pending_first_sync', 'pending_first_sync');
  }
  if (failing) return out('degraded', 'recent_failures');
  if ((stalenessMs ?? 0) > p.staleAfterMs(f.platform)) return out('degraded', 'sync_stale');
  if (ingestLagMs > p.lagDegradedMs) return out('degraded', 'ingest_lag');
  return out('healthy', 'ok');
}
