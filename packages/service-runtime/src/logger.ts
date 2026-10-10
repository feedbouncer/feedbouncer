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

// A URL token runs from "//" to whitespace, a quote or an angle bracket.
const URL_TOKEN = /\/\/([^\s'"<>]+)/g;
const SECRET_PAIR =
  /([\w-]*(?:password|passwd|pwd|secret|token|apikey|api_key))(\s*[=:]\s*)([^\s&,;'"]+)/gi;

// Position of the last "@" that ends the userinfo of a URL token, or -1.
// The authority ends at the first "/", "?" or "#", so an "@" there is userinfo
// (the LAST one, because a password may hold a raw "@"). Some drivers also
// accept a raw "/" in the password: a "user:password" authority whose tail is
// not a port is then treated as userinfo up to the last "@" in the token.
// Anything else ("http://host/a@b") has no credentials and is left alone.
function userinfoEnd(token: string): number {
  const authorityEnd = token.search(/[/?#]/);
  const authority = authorityEnd === -1 ? token : token.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at !== -1) return at;
  if (authorityEnd !== -1 && !authority.startsWith('[') && /^[^:]*:(?!\d*$).*$/.test(authority)) {
    return token.lastIndexOf('@');
  }
  return -1;
}

export function redact(text: string): string {
  return text
    .replace(URL_TOKEN, (match, token: string) => {
      const end = userinfoEnd(token);
      return end === -1 ? match : `//[redacted]@${token.slice(end + 1)}`;
    })
    .replace(SECRET_PAIR, (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
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
