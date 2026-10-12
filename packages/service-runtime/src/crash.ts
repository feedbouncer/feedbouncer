// Last-resort handlers: one redacted log line (errorFields never includes the
// stack or unredacted message), then exit 1 so the orchestrator restarts us.
import { errorFields, type Logger } from './logger.js';

export interface CrashProcess {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => void): unknown;
  exit(code: number): void;
}

export function installCrashHandlers(log: Logger, proc: CrashProcess = process): void {
  proc.on('uncaughtException', (err) => {
    log.error('uncaught exception', errorFields(err));
    proc.exit(1);
  });
  proc.on('unhandledRejection', (err) => {
    log.error('unhandled rejection', errorFields(err));
    proc.exit(1);
  });
}
