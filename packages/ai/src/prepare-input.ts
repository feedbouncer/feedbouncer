export interface PreparedInput {
  /** What is sent to the model (possibly truncated). */
  readonly text: string;
  /** No visible characters at all: not sent to the model. */
  readonly empty: boolean;
  /** Emoji-only or fewer than 3 letters/digits: results never trigger hide/remove. */
  readonly lowSignal: boolean;
  readonly truncated: boolean;
  /** Original length in UTF-16 code units. */
  readonly inputChars: number;
}

export const MAX_INPUT_CHARS = 4_000;
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
const INVISIBLE =
  /[\s\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_INPUT_CHARS) return { text: s, truncated: false };
  let out = '';
  for (const { segment } of GRAPHEMES.segment(s)) {
    if (out.length + segment.length > MAX_INPUT_CHARS) break;
    out += segment;
  }
  if (out === '') {
    for (const ch of s) {
      if (out.length + ch.length > MAX_INPUT_CHARS) break;
      out += ch;
    }
  }
  return { text: out, truncated: true };
}

export function prepareInput(body: string): PreparedInput {
  const visible = body.replace(INVISIBLE, '');
  const empty = visible.length === 0;
  const letters = visible.match(LETTER_OR_DIGIT)?.length ?? 0;
  const { text, truncated } = truncate(body);
  const finalText = empty ? '' : text;
  return {
    text: finalText,
    empty: finalText === '',
    lowSignal: empty || letters < 3,
    truncated,
    inputChars: body.length,
  };
}
