// The YouTube connector the API registers for the connect flow and moderation actions.
// Independent of the Meta config: it runs on its own Google OAuth client. Null when not enabled.
// OAuth-time calls have no connection yet, so they are metered against the project quota.
import type { Connector, QuotaMeter } from '@feedbouncer/connectors';
import { createYouTubeConnector } from '@feedbouncer/connector-youtube';
import type { ApiEnv } from './env.js';

export interface YouTubeDeps {
  readonly connectors: readonly Connector[];
}

export function buildYouTubeDeps(
  env: Pick<ApiEnv, 'youtube'>,
  projectQuota: QuotaMeter,
): YouTubeDeps | null {
  const { youtube } = env;
  if (!youtube) return null;
  return {
    connectors: [
      createYouTubeConnector({
        clientId: youtube.clientId,
        clientSecret: youtube.clientSecret,
        projectQuota,
      }),
    ],
  };
}
