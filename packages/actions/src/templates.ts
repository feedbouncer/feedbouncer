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

// Whitespace-like controls become spaces so words stay separate.
const SPACE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
// Remaining control and format chars (bidi, zero-width, joiners, tag chars), variation
// selectors, and invisible fillers that render as nothing.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Variation_Selector}\u034F\u115F\u1160\u3164\uFFA0]/gu;
// Anything that could introduce a scheme, path, mention, tag or template brace.
const LINK_CHARS = /[:/\\@#{}]/u;
// Dot-like characters: full stops from many scripts (NFKC maps only some of them to ".").
const DOTS =
  '.\u0589\u06D4\u0701\u0702\u0964\u0965\u166E\u1803\u1809\u2024\u2E3C\u3002\uA4FF\uA60E\uA6F3\uA8CE\uFE52\uFF0E\uFF61';
// A dot between two non-space characters is domain-, address- or version-like.
const INNER_DOT = new RegExp(`\\S[${DOTS}]\\S`, 'u');

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** True when a human name could carry a link, domain, address, mention, tag or brace. */
function looksLikeLink(cleaned: string): boolean {
  // Combining marks can be used to separate a dot from its neighbours; test without them.
  const bare = cleaned.normalize('NFD').replace(/\p{M}/gu, '');
  return LINK_CHARS.test(bare) || INNER_DOT.test(bare);
}

/**
 * Cleans a platform-supplied value for use in a public reply. Returns null when the value is
 * empty or, unless `trusted`, could carry a link, domain, mention, tag or template brace.
 * Trusted values (owner-set brand name, platform constants) skip only that last check.
 */
export function sanitizeValue(
  raw: string | null | undefined,
  max: number,
  options: { trusted?: boolean } = {},
): string | null {
  if (!raw) return null;
  // Strip, normalize, strip again: NFKC can itself produce characters that need removing.
  const cleaned = raw
    .replace(SPACE_CONTROLS, ' ')
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '') return null;
  if (!options.trusted && looksLikeLink(cleaned)) return null;

  // The limit is both a grapheme and a code point limit (worstCaseLength relies on the latter):
  // keep whole graphemes while both fit. If the first grapheme alone is too long (a base
  // with thousands of combining marks), cut it by code points and drop the dangling marks.
  let out = '';
  let used = 0;
  let count = 0;
  for (const { segment } of segmenter.segment(cleaned)) {
    const size = [...segment].length;
    if (count === max || used + size > max) {
      if (count === 0)
        out = [...segment]
          .slice(0, max)
          .join('')
          .replace(/\p{M}+$/u, '');
      break;
    }
    out += segment;
    used += size;
    count += 1;
  }
  out = out.trimEnd();
  return out === '' ? null : out;
}

function resolve(name: TemplateVariable, v: TemplateValues): string | null {
  if (name === 'author_first_name') {
    const full = sanitizeValue(v.author_name, TEMPLATE_VARIABLES.author_name.max);
    const first = full?.split(' ')[0];
    return first ? sanitizeValue(first, TEMPLATE_VARIABLES.author_first_name.max) : null;
  }
  // Only platform-supplied author names get the link filter.
  const trusted = name !== 'author_name';
  return sanitizeValue(v[name], TEMPLATE_VARIABLES[name].max, { trusted });
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
