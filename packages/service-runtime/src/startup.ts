import { EnvError } from './env.js';
import type { Logger } from './logger.js';
import { redact } from './redaction.js';

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

export function writeStartupConfigError(
  service: string,
  err: unknown,
  write: (line: string) => void = (l) => {
    process.stderr.write(`${l}\n`);
  },
): void {
  write(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      service,
      msg: 'invalid configuration',
      error: err instanceof EnvError ? redact(err.message) : 'Invalid configuration',
    }),
  );
}
