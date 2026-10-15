import { describe, expect, it } from 'vitest';
import { compilePattern, RegexCompileError } from './regex.js';

describe('compilePattern', () => {
  it('matches case-insensitively with unicode classes', () => {
    expect(compilePattern('fr[e3]{2}\\s+money').test('FREE   money')).toBe(true);
    expect(compilePattern('\\p{Han}+').test('無料')).toBe(true);
  });
  it('rejects syntax errors with a readable message', () => {
    expect(() => compilePattern('(unclosed')).toThrow(RegexCompileError);
  });
  it('rejects backreferences and look-around (backtracking-only constructs)', () => {
    expect(() => compilePattern('(a)\\1')).toThrow(RegexCompileError);
    expect(() => compilePattern('foo(?=bar)')).toThrow(RegexCompileError);
    expect(() => compilePattern('(?<!x)y')).toThrow(RegexCompileError);
  });
  it('runs a classic catastrophic pattern in linear time', () => {
    const re = compilePattern('(a+)+$');
    const t0 = performance.now();
    expect(re.test('a'.repeat(50_000) + '!')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('rejects empty and over-long patterns', () => {
    expect(() => compilePattern('')).toThrow(RegexCompileError);
    expect(() => compilePattern('a'.repeat(501))).toThrow(RegexCompileError);
  });
  it('error message never exceeds 300 chars', () => {
    try {
      compilePattern('(' + 'x'.repeat(490));
    } catch (e) {
      expect((e as Error).message.length).toBeLessThanOrEqual(300);
    }
  });
});
