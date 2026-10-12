// A token is a maximal run of non-whitespace: a password may contain quotes,
// commas or brackets, so those must not split it. Scanned linearly, because
// redact() runs on arbitrary error text.
const TOKEN = /\S+/g;
const SECRET_PAIR =
  /(password|passwd|pwd|secret|token|apikey|api_key|encryption_keys?)(["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&,;'"]+)/gi;
// An HTTP credential header ("Authorization: ...", "Proxy-Authorization: ...",
// their JSON-escaped forms and a one-element array form). A known single-token
// scheme (bearer, basic, token, negotiate, ntlm, apikey) stays readable and the
// one credential after it (a quoted string, or a run up to whitespace, comma,
// semicolon or quote) is masked. "Digest" and every other scheme carry
// parameter lists, so everything after the colon (or after "Digest") up to the
// end of the line is masked and the unknown scheme word goes with it. Over-
// redaction is preferred to leaking. Every class is a single run, so scanning
// stays linear.
const AUTH_HEADER =
  /((?:proxy-)?authorization(?:\\?["'])?\s*[:=]\s*(?:\[\s*)?(?:\\?["'])?)(?:(digest)([ \t]+)[^\r\n]+|(bearer|basic|token|negotiate|ntlm|apikey)([ \t]+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;'"\\]+)|[^\r\n]+)/gi;
// A bare "Bearer <token>" outside a header.
const BEARER = /\b(bearer\s+)[^\s,;'"\\]+/gi;

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

export function isSecretField(name: string): boolean {
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
    .replace(
      AUTH_HEADER,
      (_m, prefix: string, digest?: string, _digestWs?: string, scheme?: string) =>
        digest
          ? `${prefix}${digest} [redacted]`
          : `${prefix}${scheme ? `${scheme} ` : ''}[redacted]`,
    )
    .replace(BEARER, '$1[redacted]')
    .replace(SECRET_PAIR, (_m, key: string, sep: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${key}${sep}${quote}[redacted]${quote}`;
    });
}
