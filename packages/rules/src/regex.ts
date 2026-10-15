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
    // RE2 messages look like "<reason>: <pattern fragment>". Keep only the reason so
    // user-supplied pattern text never reaches error messages, issues or logs.
    const raw = e instanceof Error ? e.message : '';
    const reason = raw.split(': ')[0] ?? '';
    const safe = /^[a-z][a-z \-()\]\[]{0,60}$/i.test(reason) ? `: ${reason}` : '.';
    throw new RegexCompileError(`Invalid regular expression${safe}`);
  }
}
