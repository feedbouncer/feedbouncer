// Structured logger (JSON lines on stdout) with correlation context.
import { errorClassOf } from './error-class.js';
import { currentLogContext } from './log-context.js';
import { isSecretField, redact } from './redaction.js';
import { currentTraceIds } from './tracing.js';
export { isSecretField, redact } from './redaction.js';

const RESERVED = new Set(['time', 'level', 'service', 'msg']);

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function errorFields(err: unknown): LogFields {
  if (!(err instanceof Error)) {
    return { error: 'NonError', errorCode: null, errorMessage: null, errorClass: null };
  }
  const code = (err as { code?: unknown }).code;
  return {
    error: err.name,
    errorCode: typeof code === 'string' || typeof code === 'number' ? code : null,
    errorMessage: redact(err.message),
    errorClass: errorClassOf(err),
  };
}

export function createLogger(
  service: string,
  level: LogLevel,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Logger {
  const min = LOG_LEVELS.indexOf(level);
  const emit =
    (lvl: LogLevel) =>
    (msg: string, fields: LogFields = {}): void => {
      if (LOG_LEVELS.indexOf(lvl) < min) return;
      try {
        const safe: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (RESERVED.has(k)) continue;
          safe[k] = isSecretField(k) ? '[redacted]' : typeof v === 'string' ? redact(v) : v;
        }
        write(
          JSON.stringify({
            time: new Date().toISOString(),
            level: lvl,
            service,
            msg: redact(msg),
            ...currentLogContext(),
            ...(currentTraceIds() ?? {}),
            ...safe,
          }),
        );
      } catch {
        // Logging must never fail the caller (EPIPE, a full disk, a throwing test sink).
      }
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
