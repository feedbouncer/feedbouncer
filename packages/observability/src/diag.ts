import type { DiagLogger } from '@opentelemetry/api';
import { redact, type Logger } from '@feedbouncer/service-runtime';

// redact() masks bearer credentials of 8 or more characters; this additionally
// scrubs short bearer tokens.
const BEARER = /\b(bearer\s+)\S+/gi;

export function diagToLogger(log: Logger, now: () => number = Date.now): DiagLogger {
  const last = new Map<string, number>();
  const emit = (message: string): void => {
    try {
      // Redact before truncating so a secret cut at the limit cannot escape the patterns.
      const key = redact(String(message).replace(BEARER, '$1[redacted]')).slice(0, 120);
      const t = now();
      if ((last.get(key) ?? -Infinity) > t - 60_000) return;
      if (last.size > 100) last.clear();
      last.set(key, t);
      log.warn('telemetry.exporter_problem', { detail: key });
    } catch {
      // Telemetry never fails work.
    }
  };
  const ignore = (): void => {};
  return { error: emit, warn: emit, info: ignore, debug: ignore, verbose: ignore };
}
