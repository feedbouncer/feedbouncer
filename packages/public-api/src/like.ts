/** Escapes `\`, `%` and `_` so user text matches literally in a LIKE pattern with ESCAPE '\'. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
