import { errorFields, type Logger } from './logger.js';

type Signal = 'SIGTERM' | 'SIGINT';
export interface ShutdownProcess {
  on(event: Signal, listener: () => void): unknown;
  exit(code: number): void;
}

export function onShutdown(
  cleanup: () => Promise<void>,
  log: Logger,
  proc: ShutdownProcess = process,
): void {
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.on(signal, () => {
      if (stopping) {
        log.warn('second signal during shutdown, forcing exit', { signal });
        proc.exit(1);
        return;
      }
      stopping = true;
      log.info('shutting down', { signal });
      cleanup().then(
        () => proc.exit(0),
        (err: unknown) => {
          log.error('shutdown failed', errorFields(err));
          proc.exit(1);
        },
      );
    });
  }
}
