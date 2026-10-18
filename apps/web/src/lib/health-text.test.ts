import { describe, expect, it } from 'vitest';
import { healthText } from './health-text';

const h = (o: Partial<Parameters<typeof healthText>[0]>) =>
  healthText({
    status: 'degraded',
    reason: 'ingest_lag',
    lastErrorCode: null,
    ingestLagSeconds: 0,
    failedImports: 0,
    ...o,
  });

describe('healthText', () => {
  it.each(['rate_limited', 'budget_exhausted'])('explains Meta throttling (%s)', (code) =>
    expect(h({ reason: 'recent_failures', lastErrorCode: code })).toBe(
      'Processing delayed: Meta asked FeedBouncer to slow down. New comments are queued and will be checked; none are dropped.',
    ),
  );
  it('reports ingest lag in whole minutes, rounded up', () => {
    expect(h({ ingestLagSeconds: 1200 })).toBe('Processing delayed by about 20 minutes.');
    expect(h({ ingestLagSeconds: 1201 })).toBe('Processing delayed by about 21 minutes.');
  });
  it.each(['sync_stale', 'recent_failures'])('says it is retrying (%s)', (reason) =>
    expect(h({ reason })).toBe(
      "FeedBouncer is having trouble reaching this account. We're retrying.",
    ),
  );
  it('waits for the first comments', () =>
    expect(h({ status: 'pending_first_sync', reason: 'pending_first_sync' })).toBe(
      'Waiting for the first comments.',
    ));
  it('healthy with no failed imports shows nothing', () =>
    expect(h({ status: 'healthy', reason: 'ok' })).toBeNull());
  it('appends failed imports, pluralised', () => {
    expect(h({ status: 'healthy', reason: 'ok', failedImports: 1 })).toBe(
      "1 comment couldn't be imported. FeedBouncer support has been notified.",
    );
    expect(h({ reason: 'sync_stale', failedImports: 3 })).toBe(
      "FeedBouncer is having trouble reaching this account. We're retrying. 3 comments couldn't be imported. FeedBouncer support has been notified.",
    );
  });
  it('falls back for an unknown reason', () =>
    expect(h({ reason: 'connection_error' })).toBe('This connection needs attention.'));
});
