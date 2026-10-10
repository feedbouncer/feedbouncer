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

// Tokens are scanned linearly (no regex that can backtrack over the whole
// input), because redact() runs on arbitrary error text.
const TOKEN = /[^\s'"<>,;]+/g;
const SECRET_PAIR =
  /(password|passwd|pwd|secret|token|apikey|api_key)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;'"]+)/gi;

// Inside a token, everything between the first "//" and the LAST "@" is
// treated as userinfo. A password may itself contain "@", "/", "?" or "#", so
// over-redaction (e.g. an "@" in a URL path) is preferred to leaking.
function redactToken(token: string): string {
  const start = token.indexOf('//');
  if (start === -1) return token;
  const at = token.lastIndexOf('@');
  if (at < start + 2) return token;
  return `${token.slice(0, start + 2)}[redacted]${token.slice(at)}`;
}

export function redact(text: string): string {
  return text
    .replace(TOKEN, redactToken)
    .replace(SECRET_PAIR, (_m, key: string, sep: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${key}${sep}${quote}[redacted]${quote}`;
    });
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
