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
  it('says "1 minute" in the singular', () =>
    expect(h({ ingestLagSeconds: 30 })).toBe('Processing delayed by about 1 minute.'));
  it.each(['disabled', 'needs_reconnection'])('shows nothing for %s', (status) =>
    expect(h({ status, reason: 'connection_error' })).toBeNull(),
  );
  it('still reports failed imports on a disabled connection', () =>
    expect(h({ status: 'disabled', reason: 'connection_error', failedImports: 2 })).toBe(
      "2 comments couldn't be imported. FeedBouncer support has been notified.",
    ));
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

describe('missing permissions', () => {
  const missing = (missingScopes: string[] | undefined) =>
    h({
      status: 'needs_reconnection',
      reason: 'oauth_scope_missing',
      ...(missingScopes && { missingScopes }),
    });

  it('names the scopes to approve', () => {
    expect(missing(['comment.list'])).toBe(
      'Missing permission: comment.list. Reconnect and approve all requested permissions.',
    );
    expect(missing(['comment.list', 'video.list'])).toBe(
      'Missing permission: comment.list, video.list. Reconnect and approve all requested permissions.',
    );
    expect(missing(['youtube.force-ssl'])).toBe(
      'Missing permission: youtube.force-ssl. Reconnect and approve all requested permissions.',
    );
  });

  it('shows only well-formed scope names', () => {
    expect(missing(['<script>alert(1)</script>', 'x'.repeat(65), 'Comment.List'])).toBe(
      'A permission is missing. Reconnect and approve all requested permissions.',
    );
    expect(missing(undefined)).toBe(
      'A permission is missing. Reconnect and approve all requested permissions.',
    );
  });
});

it('names TikTok when TikTok throttles', () =>
  expect(
    h({ platform: 'tiktok_ads', reason: 'recent_failures', lastErrorCode: 'rate_limited' }),
  ).toBe(
    'Processing delayed: TikTok asked FeedBouncer to slow down. New comments are queued and will be checked; none are dropped.',
  ));

it('names YouTube when YouTube throttles', () =>
  expect(h({ platform: 'youtube', reason: 'recent_failures', lastErrorCode: 'rate_limited' })).toBe(
    'Processing delayed: YouTube asked FeedBouncer to slow down. New comments are queued and will be checked; none are dropped.',
  ));
