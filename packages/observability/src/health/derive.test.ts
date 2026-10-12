import { describe, expect, it } from 'vitest';
import { deriveConnectionHealth, type ConnectionFacts, type HealthPolicy } from './derive.js';

const NOW = new Date('2026-10-12T12:00:00Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const policy: HealthPolicy = {
  staleAfterMs: () => 60 * 60_000,
  lagDegradedMs: 15 * 60_000,
  failuresDegraded: 3,
  firstSyncGraceMs: 60 * 60_000,
};
const base: ConnectionFacts = {
  connectionId: 'c',
  organizationId: 'o',
  brandId: 'b',
  platform: 'youtube',
  status: 'active',
  statusReason: null,
  createdAt: min(600),
  lastSuccessAt: min(5),
  lastFailureAt: null,
  lastErrorCode: null,
  lastErrorClass: null,
  consecutiveFailures: 0,
  oldestQueuedAt: null,
  accessTokenExpiresAt: null,
  hasAccessToken: true,
  refreshTokenExpiresAt: null,
  hasRefreshToken: true,
};
const d = (f: Partial<ConnectionFacts>) => deriveConnectionHealth({ ...base, ...f }, policy, NOW);

describe('deriveConnectionHealth', () => {
  it('healthy when recently synced', () =>
    expect(d({})).toMatchObject({ status: 'healthy', stalenessMs: 5 * 60_000, ingestLagMs: 0 }));
  it('an idle but syncing connector is healthy (no queued work, recent success)', () =>
    expect(d({ lastSuccessAt: min(59) }).status).toBe('healthy'));
  it('new connection with no sync yet is pending_first_sync, not lagging', () =>
    expect(d({ createdAt: min(2), lastSuccessAt: null })).toMatchObject({
      status: 'pending_first_sync',
      stalenessMs: null,
    }));
  it('a never-synced connection past the grace period is degraded', () =>
    expect(d({ createdAt: min(120), lastSuccessAt: null })).toMatchObject({
      status: 'degraded',
      reason: 'first_sync_overdue',
    }));
  it('a never-synced connection failing repeatedly is degraded early', () =>
    expect(
      d({
        createdAt: min(2),
        lastSuccessAt: null,
        consecutiveFailures: 3,
        lastFailureAt: min(1),
        lastErrorCode: 'upstream_5xx',
        lastErrorClass: 'retryable',
      }),
    ).toMatchObject({
      status: 'degraded',
      reason: 'recent_failures',
      lastErrorCode: 'upstream_5xx',
    }));
  it('stale beyond the threshold is degraded', () =>
    expect(d({ lastSuccessAt: min(61) })).toMatchObject({
      status: 'degraded',
      reason: 'sync_stale',
    }));
  it('old queued work is ingest lag', () =>
    expect(d({ oldestQueuedAt: min(16) })).toMatchObject({
      status: 'degraded',
      reason: 'ingest_lag',
      ingestLagMs: 16 * 60_000,
    }));
  it('transient auth failures are degraded, not needs_reconnection', () =>
    expect(
      d({
        consecutiveFailures: 3,
        lastErrorCode: 'oauth_access_rejected',
        lastErrorClass: 'non_retryable',
        lastFailureAt: min(1),
      }).status,
    ).toBe('degraded'));
  it('reconnect_required is needs_reconnection with its reason', () =>
    expect(
      d({ status: 'reconnect_required', statusReason: 'oauth_refresh_rejected' }),
    ).toMatchObject({
      status: 'needs_reconnection',
      reason: 'oauth_refresh_rejected',
    }));
  it('expired access and refresh tokens need reconnection', () =>
    expect(d({ accessTokenExpiresAt: min(10), refreshTokenExpiresAt: min(1) })).toMatchObject({
      status: 'needs_reconnection',
      reason: 'token_expired',
    }));
  it('expired access with a valid refresh token is fine', () =>
    expect(d({ accessTokenExpiresAt: min(10) }).status).toBe('healthy'));
  it('paused and revoked are disabled', () => {
    expect(d({ status: 'paused' }).status).toBe('disabled');
    expect(d({ status: 'revoked' }).status).toBe('disabled');
  });
  it('a future timestamp (skew) never yields negative staleness or lag', () =>
    expect(
      d({
        lastSuccessAt: new Date(NOW.getTime() + 5_000),
        oldestQueuedAt: new Date(NOW.getTime() + 5_000),
      }),
    ).toMatchObject({ stalenessMs: 0, ingestLagMs: 0, status: 'healthy' }));
  it('follows the decision order: disabled beats reconnect beats token expiry beats error', () => {
    const expired = { accessTokenExpiresAt: min(10), refreshTokenExpiresAt: min(1) };
    expect(d({ status: 'paused', ...expired }).status).toBe('disabled');
    expect(d({ status: 'reconnect_required', ...expired })).toMatchObject({
      status: 'needs_reconnection',
      reason: 'reconnect_required',
    });
    expect(d({ status: 'error', ...expired }).reason).toBe('token_expired');
    expect(d({ status: 'error' })).toMatchObject({ status: 'degraded' });
  });
  it('failures outrank staleness, staleness outranks lag', () => {
    expect(
      d({ consecutiveFailures: 3, lastSuccessAt: min(90), oldestQueuedAt: min(30) }).reason,
    ).toBe('recent_failures');
    expect(d({ lastSuccessAt: min(90), oldestQueuedAt: min(30) }).reason).toBe('sync_stale');
  });
});
