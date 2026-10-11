import type { Logger } from './logger.js';

interface LoadedConfig {
  readonly appEnv: string;
  readonly encryption: { readonly activeKeyId: string };
}

// The field is not named *encryptionKey*: the logger redacts any field whose
// name looks like key material, and the id is what operators need to see.
export function logConfigurationLoaded(log: Logger, env: LoadedConfig): void {
  log.info('configuration loaded', {
    appEnv: env.appEnv,
    activeKeyId: env.encryption.activeKeyId,
  });
}
