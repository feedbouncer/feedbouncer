import { describe, expect, it } from 'vitest';
import { MAX_INPUT_CHARS } from '@feedbouncer/ai';
import { CheckJobData, MAX_CHECK_TEXT_UNITS, validateCheckText } from './transport.js';

describe('validateCheckText', () => {
  it.each([
    ['a lone surrogate', '\ud800', 'malformed'],
    ['a NUL character', 'a\u0000b', 'malformed'],
    ['only invisible characters', '  ​⁦', 'empty'],
    ['more than 4000 UTF-16 units', '😀'.repeat(2000) + 'a', 'too_long'],
  ] as const)('rejects %s', (_, text, problem) => {
    expect(validateCheckText(text)).toEqual({ ok: false, problem });
  });

  it('accepts exactly 4000 UTF-16 units', () => {
    expect(validateCheckText('😀'.repeat(2000))).toEqual({ ok: true });
  });
});

it('keeps the text limit equal to the classifier input limit', () => {
  expect(MAX_CHECK_TEXT_UNITS).toBe(MAX_INPUT_CHARS);
});

describe('CheckJobData', () => {
  const valid = {
    v: 1,
    organizationId: '6f1c1e0e-5c5b-4f0e-8d57-0a7f0f6d2b11',
    brandId: '0b8f2f4e-7a0c-4e0a-9a43-6f3a1d9f6c22',
    text: 'hello',
    deadlineAt: 1_700_000_000_000,
  };

  it('accepts a valid job', () => {
    expect(CheckJobData.safeParse(valid).success).toBe(true);
  });
  it('rejects extra keys', () => {
    expect(CheckJobData.safeParse({ ...valid, ref: 'x' }).success).toBe(false);
  });
});
