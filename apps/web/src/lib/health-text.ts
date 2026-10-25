import { SCOPE_NAME } from './scope-name';

export interface HealthTextInput {
  platform?: string;
  status: string;
  reason: string;
  lastErrorCode: string | null;
  ingestLagSeconds: number;
  failedImports: number;
  missingScopes?: string[];
}

const APPROVE = 'Reconnect and approve all requested permissions.';

function missingPermissionText(scopes: string[] | undefined): string {
  const named = (scopes ?? []).filter((s) => SCOPE_NAME.test(s));
  return named.length > 0
    ? `Missing permission: ${named.join(', ')}. ${APPROVE}`
    : `A permission is missing. ${APPROVE}`;
}

const throttler = (platform: string | undefined): string =>
  platform === 'tiktok' || platform === 'tiktok_ads'
    ? 'TikTok'
    : platform === 'youtube'
      ? 'YouTube'
      : 'Meta';

function statusText(h: HealthTextInput): string | null {
  switch (h.status) {
    case 'needs_reconnection':
      return h.reason === 'oauth_scope_missing' ? missingPermissionText(h.missingScopes) : null;
    case 'healthy':
    case 'disabled':
      return null;
    case 'pending_first_sync':
      return 'Waiting for the first comments.';
    case 'degraded':
      if (h.lastErrorCode === 'rate_limited' || h.lastErrorCode === 'budget_exhausted')
        return `Processing delayed: ${throttler(h.platform)} asked FeedBouncer to slow down. New comments are queued and will be checked; none are dropped.`;
      if (h.reason === 'ingest_lag') {
        const minutes = Math.max(1, Math.ceil(h.ingestLagSeconds / 60));
        return `Processing delayed by about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
      }
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
