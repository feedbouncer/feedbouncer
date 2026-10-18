export interface HealthTextInput {
  status: string;
  reason: string;
  lastErrorCode: string | null;
  ingestLagSeconds: number;
  failedImports: number;
}

function statusText(h: HealthTextInput): string | null {
  switch (h.status) {
    case 'healthy':
      return null;
    case 'pending_first_sync':
      return 'Waiting for the first comments.';
    case 'degraded':
      if (h.lastErrorCode === 'rate_limited' || h.lastErrorCode === 'budget_exhausted')
        return 'Processing delayed: Meta asked FeedBouncer to slow down. New comments are queued and will be checked; none are dropped.';
      if (h.reason === 'ingest_lag')
        return `Processing delayed by about ${Math.ceil(h.ingestLagSeconds / 60)} minutes.`;
      if (h.reason === 'sync_stale' || h.reason === 'recent_failures')
        return "FeedBouncer is having trouble reaching this account. We're retrying.";
  }
  return 'This connection needs attention.';
}

// Delay and failed-import notice for a connection; null when there is nothing to say.
export function healthText(h: HealthTextInput): string | null {
  const status = statusText(h);
  if (h.failedImports <= 0) return status;
  const failed = `${h.failedImports} ${h.failedImports === 1 ? 'comment' : 'comments'} couldn't be imported. FeedBouncer support has been notified.`;
  return status ? `${status} ${failed}` : failed;
}
