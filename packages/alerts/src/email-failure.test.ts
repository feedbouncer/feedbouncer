import { describe, expect, it } from 'vitest';
import { classifyEmailFailure } from './email-failure.js';

const failing = (cause: object) => new Error('send failed', { cause });

describe('classifyEmailFailure', () => {
  it('550 -> invalid smtp_550', () => {
    expect(classifyEmailFailure(failing({ responseCode: 550 }))).toEqual({
      ok: false,
      kind: 'invalid',
      code: 'smtp_550',
    });
  });

  it('421 -> transient smtp_421', () => {
    expect(classifyEmailFailure(failing({ responseCode: 421 }))).toEqual({
      ok: false,
      kind: 'transient',
      code: 'smtp_421',
    });
  });

  it('ECONNECTION -> transient econnection', () => {
    expect(classifyEmailFailure(failing({ code: 'ECONNECTION' }))).toEqual({
      ok: false,
      kind: 'transient',
      code: 'econnection',
    });
  });

  it("'Bad!' code -> smtp_error", () => {
    expect(classifyEmailFailure(failing({ code: 'Bad!' }))).toEqual({
      ok: false,
      kind: 'transient',
      code: 'smtp_error',
    });
    expect(classifyEmailFailure('boom')).toMatchObject({ kind: 'transient', code: 'smtp_error' });
  });
});
