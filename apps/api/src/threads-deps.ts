// The Threads connector the API registers for the connect flow, moderation actions and
// the webhook route. Independent of the Meta config: Threads runs on its own app, with
// its own secret. Null when Threads is not enabled.
import { createThreadsConnector } from '@feedbouncer/connector-threads';
import type { Connector } from '@feedbouncer/connectors';
import type { Logger, Secret } from '@feedbouncer/service-runtime';
import type { ApiEnv } from './env.js';

export interface ThreadsDeps {
  readonly connectors: readonly Connector[];
  readonly appSecrets: { readonly threads: Secret };
}

export function buildThreadsDeps(env: Pick<ApiEnv, 'threads'>, log: Logger): ThreadsDeps | null {
  const cfg = env.threads;
  if (!cfg) return null;
  return {
    // The connector logs codes and ids only, never tokens or reply text.
    connectors: [createThreadsConnector(cfg, { log: (msg, fields) => log.warn(msg, fields) })],
    appSecrets: { threads: cfg.appSecret },
  };
}
