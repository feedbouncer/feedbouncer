import type { Logger } from '@feedbouncer/service-runtime';
import type { ApiEnv } from './env.js';

// The field is not named *encryptionKey*: the logger redacts any field whose
// name looks like key material, and the id is what operators need to see.
export function logConfigurationLoaded(log: Logger, env: ApiEnv): void {
  log.info('configuration loaded', {
    appEnv: env.appEnv,
    activeKeyId: env.encryption.activeKeyId,
  });
}
