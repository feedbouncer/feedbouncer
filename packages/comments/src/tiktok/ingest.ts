// What both TikTok poll jobs share: their settings and dependencies, and
// resolving the connection's active account.
import { JobError } from '@feedbouncer/jobs';
import type { ConnectorRuntime } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { CommentAppliedHook } from '../hooks.js';
import type { PgCommentStore } from '../store.js';
import type { PgTikTokPolling } from './polling.js';

export interface TikTokPollSettings {
  pollIntervalSec: number;
  quietVideoPollIntervalSec: number;
  activeVideoDays: number;
  videoDiscoveryIntervalSec: number;
  deepScanIntervalSec: number;
  sourceUnavailableRetrySec: number;
  maxSourcesPerJob: number;
  adsPollIntervalSec: number;
  adsOverlapSec: number;
  adsFullScanIntervalSec: number;
  maxPagesPerJob: number;
}

export interface TikTokPollDeps {
  readonly runtime: ConnectorRuntime;
  readonly polling: PgTikTokPolling;
  readonly store: PgCommentStore;
  readonly clock: () => Date;
  readonly settings: TikTokPollSettings;
  /** Called for live comments that are new or whose text changed; a throw fails the job after the pass. */
  readonly applied?: CommentAppliedHook;
}

export const SEC = 1000;
export const DAY_MS = 86_400_000;

/** The connection the job was enqueued for; null when it is no longer active. */
export async function activeAccount(
  d: TikTokPollDeps,
  scope: ConnectionScope,
  connectionId: string,
): Promise<string | null> {
  if (connectionId !== scope.connectionId) throw new JobError('non_retryable', 'scope_mismatch');
  const acct = await d.polling.account(scope);
  if (!acct) throw new JobError('non_retryable', 'connection_not_found');
  return acct.status === 'active' ? acct.externalAccountId : null;
}
