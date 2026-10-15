import { describe, expect, it } from 'vitest';
import { MAX_INPUT_CHARS, prepareInput } from './prepare-input.js';

describe('prepareInput', () => {
  it('empty and whitespace / invisible-only text is empty and low-signal', () => {
    for (const s of ['', '   ', '\u200B\u200C\n\t', '\uFEFF']) {
      expect(prepareInput(s)).toMatchObject({ empty: true, lowSignal: true, truncated: false });
    }
  });
  it('emoji-only and very short text is low-signal but not empty', () => {
    for (const s of ['😀', '👍🏽👍🏽', '👨‍👩‍👧', 'ok', '!!', 'a 😀']) {
      expect(prepareInput(s)).toMatchObject({ empty: false, lowSignal: true });
    }
  });
  it('three or more letters/digits in any script is not low-signal', () => {
    for (const s of ['buy', '無料です', 'бесплатно', '123'])
      expect(prepareInput(s).lowSignal).toBe(false);
  });
  it('truncates deterministically at a grapheme boundary and records it', () => {
    const long = 'a'.repeat(MAX_INPUT_CHARS - 1) + '👨‍👩‍👧' + 'tail';
    const p = prepareInput(long);
    expect(p.truncated).toBe(true);
    expect(p.text).toBe('a'.repeat(MAX_INPUT_CHARS - 1));
    expect(p.inputChars).toBe(long.length);
    expect(prepareInput(long)).toEqual(p);
  });
  it('an oversized single grapheme never yields empty text', () => {
    const p = prepareInput('a' + '\u0301'.repeat(5000));
    expect(p.truncated).toBe(true);
    expect(p.empty).toBe(false);
    expect(p.text.length).toBeGreaterThan(0);
    expect(p.text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
  });
  it('does not split a surrogate pair in the fallback slice', () => {
    const p = prepareInput('\u{1F600}\u0301'.repeat(3000));
    expect(p.text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(p.text.at(-1)).not.toMatch(/[\uD800-\uDBFF]/);
  });
  it('exactly the limit is not truncated', () => {
    const p = prepareInput('a'.repeat(MAX_INPUT_CHARS));
    expect(p.truncated).toBe(false);
    expect(p.text.length).toBe(MAX_INPUT_CHARS);
  });
  it('text within the limit is unchanged', () => {
    expect(prepareInput('Hello there')).toEqual({
      text: 'Hello there',
      empty: false,
      lowSignal: false,
      truncated: false,
      inputChars: 11,
    });
  });
});
