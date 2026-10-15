import type { PreparedInput } from './types.js';

export const MAX_INPUT_CHARS = 4_000;
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
const INVISIBLE =
  /[\s­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_INPUT_CHARS) return { text: s, truncated: false };
  let out = '';
  for (const { segment } of GRAPHEMES.segment(s)) {
    if (out.length + segment.length > MAX_INPUT_CHARS) break;
    out += segment;
  }
  return { text: out, truncated: true };
}

export function prepareInput(body: string): PreparedInput {
  const visible = body.replace(INVISIBLE, '');
  const empty = visible.length === 0;
  const letters = visible.match(LETTER_OR_DIGIT)?.length ?? 0;
  const { text, truncated } = truncate(body);
  return {
    text: empty ? '' : text,
    empty,
    lowSignal: empty || letters < 3,
    truncated,
    inputChars: body.length,
  };
}
