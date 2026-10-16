/** Variables a reply template may use, with their length cap and default when unusable. */
export const TEMPLATE_VARIABLES = {
  author_name: { max: 50, fallback: 'there' },
  author_first_name: { max: 30, fallback: 'there' },
  brand_name: { max: 100, fallback: '' },
  platform: { max: 20, fallback: '' },
} as const;
export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES;
export type TemplateValues = Partial<Record<TemplateVariable, string | null>>;

export type TemplateIssueCode =
  | 'empty'
  | 'too_long'
  | 'unknown_variable'
  | 'malformed_token'
  | 'too_many_tokens';
export type TemplateValidation =
  | { ok: true }
  | { ok: false; code: TemplateIssueCode; index?: number };

const MAX_TEMPLATE_LENGTH = 2000;
const MAX_TOKENS = 20;

const TOKEN = /\{\{\s*([a-z_]{1,32})\s*(?:\|([^{}|\n]{0,50}))?\}\}/g;

const isVariable = (name: string): name is TemplateVariable =>
  Object.hasOwn(TEMPLATE_VARIABLES, name);

const codePoints = (s: string) => [...s].length;

export function validateTemplate(t: string): TemplateValidation {
  const length = codePoints(t.trim());
  if (length === 0) return { ok: false, code: 'empty' };
  if (length > MAX_TEMPLATE_LENGTH) return { ok: false, code: 'too_long' };

  const tokens = [...t.matchAll(TOKEN)];
  if (tokens.length > MAX_TOKENS) return { ok: false, code: 'too_many_tokens' };

  const unknown = tokens.find((m) => !isVariable(m[1] ?? ''));
  if (unknown) return { ok: false, code: 'unknown_variable', index: unknown.index };

  // Blank out valid tokens (same length, keeps indices) and look for stray braces.
  const rest = t.replace(TOKEN, (m) => ' '.repeat(m.length));
  const stray = rest.search(/\{\{|\}\}/);
  if (stray !== -1) return { ok: false, code: 'malformed_token', index: stray };
  return { ok: true };
}

// Control, format (bidi, zero-width, joiners, tag chars), line/paragraph separators,
// variation selectors, and invisible fillers that render as nothing.
const INVISIBLE =
  /[\p{Cc}\p{Cf}\u2028\u2029\p{Variation_Selector}\u034F\u115F\u1160\u3164\uFFA0]/gu;
// Link-, domain-, mention- or token-like. The dot class includes the ideographic full stop
// (U+3002), which NFKC leaves unchanged.
const UNSAFE = /https?:|www[.\u3002]|[@#{}]|[\p{L}\p{N}-][.\u3002]\p{L}{2,}/iu;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Cleans a platform-supplied value for use in a public reply. Returns null when the value is
 * empty or could carry a link, domain, mention, tag or template brace.
 */
export function sanitizeValue(raw: string | null | undefined, max: number): string | null {
  if (!raw) return null;
  // Strip, normalize, strip again: NFKC can itself produce characters that need removing.
  const cleaned = raw
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '' || UNSAFE.test(cleaned)) return null;
  const graphemes = [...segmenter.segment(cleaned)];
  if (graphemes.length <= max) return cleaned;
  return graphemes
    .slice(0, max)
    .map((g) => g.segment)
    .join('')
    .trimEnd();
}

function resolve(name: TemplateVariable, v: TemplateValues): string | null {
  if (name === 'author_first_name') {
    const full = sanitizeValue(v.author_name, TEMPLATE_VARIABLES.author_name.max);
    const first = full?.split(' ')[0];
    return first ? sanitizeValue(first, TEMPLATE_VARIABLES.author_first_name.max) : null;
  }
  return sanitizeValue(v[name], TEMPLATE_VARIABLES[name].max);
}

/** Single replace pass: substituted values are never scanned for further tokens. */
export function renderTemplate(t: string, v: TemplateValues): string {
  return t.replace(TOKEN, (_m, name: string, inline: string | undefined) => {
    if (!isVariable(name)) return '';
    const fallback = inline !== undefined ? inline.trim() : TEMPLATE_VARIABLES[name].fallback;
    return resolve(name, v) ?? fallback;
  });
}

/** Longest the rendered reply can be, in code points. */
export function worstCaseLength(t: string): number {
  const rendered = t.replace(TOKEN, (_m, name: string, inline: string | undefined) => {
    const max = isVariable(name) ? TEMPLATE_VARIABLES[name].max : 0;
    const fallbackLength = inline !== undefined ? codePoints(inline.trim()) : 0;
    return 'x'.repeat(Math.max(max, fallbackLength));
  });
  return codePoints(rendered);
}
