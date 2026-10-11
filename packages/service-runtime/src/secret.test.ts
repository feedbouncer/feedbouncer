import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REDACTED, Secret } from './secret.js';

const SENTINEL = 'sentinel-token-7f3a9c41e2';

describe('Secret', () => {
  const s = new Secret(SENTINEL);

  it('reveals the value only through reveal()', () => {
    expect(s.reveal()).toBe(SENTINEL);
  });

  it('redacts in JSON, string coercion and template literals', () => {
    expect(JSON.stringify({ token: s, nested: [s] })).toBe(
      `{"token":"${REDACTED}","nested":["${REDACTED}"]}`,
    );
    expect(String(s)).toBe(REDACTED);
    expect(`${s}`).toBe(REDACTED);
    expect(s + '').toBe(REDACTED);
  });

  it('redacts in util.inspect, including showHidden and customInspect:false (console.dir)', () => {
    for (const opts of [{}, { showHidden: true }, { customInspect: false, showHidden: true }]) {
      expect(inspect({ deep: { s } }, { depth: 10, ...opts })).not.toContain(SENTINEL);
    }
  });

  it('has no enumerable own properties', () => {
    expect(Object.keys(s)).toEqual([]);
    expect(Object.entries(s)).toEqual([]);
  });

  it('compares in constant time by value', () => {
    expect(s.equals(new Secret(SENTINEL))).toBe(true);
    expect(s.equals(new Secret(`${SENTINEL}x`))).toBe(false);
  });

  it('rejects empty values', () => {
    expect(() => new Secret('')).toThrow(TypeError);
  });
});
