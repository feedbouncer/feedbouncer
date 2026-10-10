// Minimal structured logger (JSON lines on stdout). The observability ticket
// may replace it; keep the redaction guarantees if you do.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const URL_USERINFO = /\/\/[^\s/@]+@/g;

export function redact(text: string): string {
  return text.replace(URL_USERINFO, '//[redacted]@');
}

export function errorFields(err: unknown): LogFields {
  if (!(err instanceof Error)) return { error: 'NonError', errorCode: null, errorMessage: null };
  const code = (err as { code?: unknown }).code;
  return {
    error: err.name,
    errorCode: typeof code === 'string' || typeof code === 'number' ? code : null,
    errorMessage: redact(err.message),
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
      const safe = Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]),
      );
      write(
        JSON.stringify({
          ...safe,
          time: new Date().toISOString(),
          level: lvl,
          service,
          msg: redact(msg),
        }),
      );
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
