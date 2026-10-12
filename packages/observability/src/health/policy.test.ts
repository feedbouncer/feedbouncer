import { describe, expect, it } from 'vitest';
import { loadHealthPolicy } from './policy.js';

describe('loadHealthPolicy', () => {
  it('defaults and per-platform staleness overrides', () => {
    const p = loadHealthPolicy({ CONNECTOR_STALE_AFTER_SECONDS_YOUTUBE: '7200' });
    expect(p.staleAfterMs('youtube')).toBe(7_200_000);
    expect(p.staleAfterMs('facebook')).toBe(3_600_000);
    expect(p).toMatchObject({
      lagDegradedMs: 900_000,
      failuresDegraded: 3,
      firstSyncGraceMs: 3_600_000,
    });
  });
  it('the global staleness value is the per-platform default', () => {
    expect(loadHealthPolicy({ CONNECTOR_STALE_AFTER_SECONDS: '120' }).staleAfterMs('x')).toBe(
      120_000,
    );
  });
  it('rejects out-of-range values', () => {
    expect(() => loadHealthPolicy({ CONNECTOR_STALE_AFTER_SECONDS: '5' })).toThrow(
      /CONNECTOR_STALE_AFTER_SECONDS/,
    );
  });
});
