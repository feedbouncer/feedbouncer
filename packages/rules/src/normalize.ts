// Text normalisation shared by every text matcher. Rule terms and comment text go
// through the same function, so matching is symmetric. Emoji matching must NOT use
// this (it removes ZWJ and variation selectors); see emoji.ts.

export const MAX_EVAL_CHARS = 20_000;

// Zero-width, joiners, bidi controls, soft hyphen, Hangul fillers, variation selectors, tags.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
// Combining marks are stripped only after Latin/Greek/Cyrillic bases: in Indic,
// Thai, Arabic etc. they carry meaning.
const FOLDABLE_MARKS = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{Mn}+/gu;
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const IDEOGRAPHIC_DOTS = /[。．｡]/g;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, '');
}

export function normalizeText(s: string): string {
  return stripInvisible(s)
    .normalize('NFKD')
    .toLowerCase()
    .replace(FOLDABLE_MARKS, '$1')
    .normalize('NFC');
}

/** Text for URL extraction: invisible chars removed, compatibility-folded, ideographic dots as '.'. Case and accents kept. */
export function linkText(raw: string): string {
  return stripInvisible(raw).normalize('NFKC').replace(IDEOGRAPHIC_DOTS, '.');
}

const WORDS = new Intl.Segmenter('en', { granularity: 'word' });

export function words(normalized: string): string[] {
  const out: string[] = [];
  for (const s of WORDS.segment(normalized)) if (s.isWordLike) out.push(s.segment);
  return out;
}

export function hasUnspacedScript(s: string): boolean {
  return UNSPACED.test(s);
}

export function truncateForEvaluation(s: string): string {
  if (s.length <= MAX_EVAL_CHARS) return s;
  let end = MAX_EVAL_CHARS;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // don't cut a surrogate pair
  return s.slice(0, end);
}
