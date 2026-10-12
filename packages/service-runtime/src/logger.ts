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

// A token is a maximal run of non-whitespace: a password may contain quotes,
// commas or brackets, so those must not split it. Scanned linearly, because
// redact() runs on arbitrary error text.
const TOKEN = /\S+/g;
const SECRET_PAIR =
  /(password|passwd|pwd|secret|token|apikey|api_key|encryption_keys?)(["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&,;'"]+)/gi;

// A field whose NAME looks secret is redacted whatever its value, so a caller
// cannot leak a token by logging it under a descriptive key.
// Names are split into words (camelCase, snake_case, kebab-case) and matched whole, so
// "bypass" or "passCount" stay readable. A secret word followed by a metadata word
// ("tokenExpiresAt", "credentialKind") describes the secret rather than holding it.
const SECRET_WORD =
  /^(?:\w*(?:token|secret|password|passwd)s?|pass|pwd|authorization|cookies?|credentials?|apikey|privatekey|encryptionkeys?)$/;
const SECRET_WORD_PAIR = /^(?:api|private|encryption)keys?$/;
const METADATA_WORD = /^(?:kind|type|count|length|expires|expiry|expiration|id)$/;

function fieldWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSecretField(name: string): boolean {
  const words = fieldWords(name);
  return words.some((word, i) => {
    const pairWord = i + 1 < words.length ? word + words[i + 1] : '';
    const holdsSecret = SECRET_WORD.test(word) || SECRET_WORD_PAIR.test(pairWord);
    const next = words[i + (SECRET_WORD.test(word) ? 1 : 2)];
    return holdsSecret && !(next !== undefined && METADATA_WORD.test(next));
  });
}

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
        Object.entries(fields).map(([k, v]) => [
          k,
          isSecretField(k) ? '[redacted]' : typeof v === 'string' ? redact(v) : v,
        ]),
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
