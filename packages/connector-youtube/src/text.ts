// Text from Google is stored as plain text: never HTML (`textDisplay`), never a URL.

/** Comment bodies are capped at this many code points. */
export const MAX_BODY_CODE_POINTS = 10_000;
const NAME_MAX = 200;

const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A channel title or author name: control and bidi characters removed, at most 200 code points. */
export function cleanName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const clean = [...raw.replace(CONTROL, '').trim()].slice(0, NAME_MAX).join('');
  return clean === '' ? null : clean;
}

/** A comment body kept literally (no unescaping, no markup), NUL replaced, truncated by code point. */
export function plainBody(raw: string): string {
  return Array.from(raw.replaceAll('\u0000', '�')).slice(0, MAX_BODY_CODE_POINTS).join('');
}
