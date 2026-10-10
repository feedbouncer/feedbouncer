import { errorFields, type Logger } from '@feedbouncer/service-runtime';

export function reportStartupFailure(log: Logger, err: unknown): void {
  const cause = errorFields(err instanceof Error ? err.cause : undefined);
  log.error('startup failed', {
    ...errorFields(err),
    cause: cause.error ?? null,
    causeCode: cause.errorCode ?? null,
    causeMessage: cause.errorMessage ?? null,
  });
}
