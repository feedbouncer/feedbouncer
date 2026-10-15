// User-supplied patterns run only in RE2 (linear time, no backreferences/look-around).
// Import form confirmed from node_modules/re2/re2.d.ts: `import RE2 from 're2'` (export =), `new RE2(p, flags)`, `.test(s)`, throws SyntaxError.
import RE2 from 're2';

export const MAX_PATTERN_CHARS = 500;
export class RegexCompileError extends Error {}
export interface CompiledPattern {
  test(s: string): boolean;
}

export function compilePattern(p: string): CompiledPattern {
  if (p.length === 0) throw new RegexCompileError('Pattern is empty.');
  if (p.length > MAX_PATTERN_CHARS)
    throw new RegexCompileError(`Pattern is longer than ${MAX_PATTERN_CHARS} characters.`);
  try {
    const re = new RE2(p, 'iu');
    return { test: (s) => re.test(s) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid pattern';
    throw new RegexCompileError(`Invalid regular expression: ${msg}`.slice(0, 300));
  }
}
