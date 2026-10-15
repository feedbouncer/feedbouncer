import { describe, expect, it } from 'vitest';
import { MAX_INPUT_CHARS, prepareInput } from './prepare.js';

describe('prepareInput', () => {
  it('empty and whitespace / invisible-only text is empty and low-signal', () => {
    for (const s of ['', '   ', '​‌\n\t', '﻿']) {
      expect(prepareInput(s)).toMatchObject({ empty: true, lowSignal: true, truncated: false });
    }
  });
  it('emoji-only and very short text is low-signal but not empty', () => {
    for (const s of ['😀', '👍🏽👍🏽', '👨‍👩‍👧', 'ok', '!!', 'a 😀']) {
      expect(prepareInput(s)).toMatchObject({ empty: false, lowSignal: true });
    }
  });
  it('three or more letters/digits in any script is not low-signal', () => {
    for (const s of ['buy', '無料です', 'бесплатно', '123']) expect(prepareInput(s).lowSignal).toBe(false);
  });
  it('truncates deterministically at a grapheme boundary and records it', () => {
    const long = 'a'.repeat(MAX_INPUT_CHARS - 1) + '👨‍👩‍👧' + 'tail';
    const p = prepareInput(long);
    expect(p.truncated).toBe(true);
    expect(p.text).toBe('a'.repeat(MAX_INPUT_CHARS - 1));
    expect(p.inputChars).toBe(long.length);
    expect(prepareInput(long)).toEqual(p);
  });
  it('text within the limit is unchanged', () => {
    expect(prepareInput('Hello there')).toEqual({ text: 'Hello there', empty: false, lowSignal: false, truncated: false, inputChars: 11 });
  });
});
