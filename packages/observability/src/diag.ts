import type { DiagLogger } from '@opentelemetry/api';
import { redact, type Logger } from '@feedbouncer/service-runtime';

export function diagToLogger(log: Logger, now: () => number = Date.now): DiagLogger {
  const last = new Map<string, number>();
  const emit = (message: string): void => {
    const key = String(message).slice(0, 120);
    const t = now();
    if ((last.get(key) ?? -Infinity) > t - 60_000) return;
    if (last.size > 100) last.clear();
    last.set(key, t);
    log.warn('telemetry.exporter_problem', { detail: redact(key) });
  };
  const ignore = (): void => {};
  return { error: emit, warn: emit, info: ignore, debug: ignore, verbose: ignore };
}
