import type { FacebookConfig } from '@feedbouncer/connector-facebook';
import { EnvError, readEnum, readInt, type Env } from '@feedbouncer/service-runtime';

export interface ScanSettings {
  enabled: boolean;
  maxComments: number;
  retentionDays: number;
  workerConcurrency: number;
}

/** The free scan settings. Enabling the tool requires the Facebook app config and a classifier. */
export function parseScanEnv(
  env: Env,
  deps: { facebook: FacebookConfig | null; classifierProvider: string },
): ScanSettings {
  const enabled = readEnum(env, 'SCAN_TOOL_ENABLED', ['true', 'false'], 'false') === 'true';
  const settings: ScanSettings = {
    enabled,
    maxComments: readInt(env, 'SCAN_MAX_COMMENTS', { min: 100, max: 5000, fallback: 2000 }),
    retentionDays: readInt(env, 'SCAN_RETENTION_DAYS', { min: 1, max: 30, fallback: 30 }),
    workerConcurrency: readInt(env, 'SCAN_WORKER_CONCURRENCY', { min: 1, max: 16, fallback: 2 }),
  };
  if (enabled && !deps.facebook) {
    throw new EnvError(
      'SCAN_TOOL_ENABLED=true requires the Facebook Meta app config (FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_WEBHOOK_VERIFY_TOKEN)',
    );
  }
  if (enabled && deps.classifierProvider === 'none') {
    throw new EnvError('SCAN_TOOL_ENABLED=true requires CLASSIFIER_PROVIDER to be set');
  }
  return settings;
}
