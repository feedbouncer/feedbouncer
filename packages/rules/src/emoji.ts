// Emoji detection works on RAW text: ZWJ (U+200D), VS16 (U+FE0F) and skin-tone
// modifiers are part of one emoji and must not be stripped before segmentation.
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
// Built via RegExp(): the tsconfig target predates the `v` flag literal; Node 24 supports it at runtime.
const RGI = new RegExp('^\\p{RGI_Emoji}$', 'v');
const SKIN_TONES_AND_VS = /[\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F]/gu;

function isEmojiGrapheme(g: string): boolean {
  return RGI.test(g) || RGI.test(`${g}\uFE0F`);
}

export function emojiGraphemes(raw: string): string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEMES.segment(raw)) if (isEmojiGrapheme(segment)) out.push(segment);
  return out;
}

/** Comparison key: skin tone and presentation selectors removed, so 👍🏽 ≡ 👍 and ❤ ≡ ❤\uFE0F. */
export function emojiKey(e: string): string {
  return e.replace(SKIN_TONES_AND_VS, '');
}

export function isSingleEmoji(s: string): boolean {
  const segs = [...GRAPHEMES.segment(s)];
  return segs.length === 1 && isEmojiGrapheme(segs[0]!.segment);
}
