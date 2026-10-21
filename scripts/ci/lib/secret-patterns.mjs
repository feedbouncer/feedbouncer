// Shapes of well-known credentials, shared by the docs checks.
export const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bEAA[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** The substrings of `text` that look like credentials. */
export const findSecretLike = (text) =>
  SECRET_PATTERNS.flatMap((re) => text.match(new RegExp(re.source, 'g')) ?? []);
