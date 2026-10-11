import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { WorkerEnv } from './env.js';

// The field is not named *encryptionKey*: the logger redacts any field whose
// name looks like key material, and the id is what operators need to see.
export function logConfigurationLoaded(log: Logger, env: WorkerEnv): void {
  log.info('configuration loaded', {
    appEnv: env.appEnv,
    activeKeyId: env.encryption.activeKeyId,
  });
}

export function reportStartupFailure(log: Logger, err: unknown): void {
  const cause = err instanceof Error && err.cause !== undefined ? errorFields(err.cause) : null;
  log.error('startup failed', {
    ...errorFields(err),
    cause: cause?.error ?? null,
    causeCode: cause?.errorCode ?? null,
    causeMessage: cause?.errorMessage ?? null,
  });
}
