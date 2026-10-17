import { describe, expect, it } from 'vitest';
import { TAG_NAME_MAX, parseTagName } from './triage.js';

describe('parseTagName', () => {
  it('trims and derives a lowercase key', () => {
    expect(parseTagName('  VIP  ')).toEqual({ ok: true, name: 'VIP', key: 'vip' });
  });
  it('rejects empty and blank names', () => {
    expect(parseTagName('')).toEqual({ ok: false, error: 'empty' });
    expect(parseTagName('   ')).toEqual({ ok: false, error: 'empty' });
  });
  it('counts code points, not UTF-16 units', () => {
    expect(parseTagName('a'.repeat(TAG_NAME_MAX + 1))).toEqual({ ok: false, error: 'too_long' });
    expect(parseTagName('🔥'.repeat(TAG_NAME_MAX)).ok).toBe(true);
    expect(parseTagName('🔥'.repeat(TAG_NAME_MAX + 1))).toEqual({ ok: false, error: 'too_long' });
  });
  it('rejects C0 and C1 control characters', () => {
    expect(parseTagName('\u0007')).toEqual({ ok: false, error: 'control_chars' });
    expect(parseTagName('\u0085')).toEqual({ ok: false, error: 'control_chars' });
    expect(parseTagName('a\u0000b')).toEqual({ ok: false, error: 'control_chars' });
    expect(parseTagName('a\u007Fb')).toEqual({ ok: false, error: 'control_chars' });
  });
});

describe('tag name keys', () => {
  const key = (s: string) => {
    const r = parseTagName(s);
    if (!r.ok) throw new Error(r.error);
    return r.key;
  };
  it('collides across case and NFC/NFD', () => {
    const k = key('Café');
    expect(key('CAFÉ')).toBe(k);
    expect(key('café')).toBe(k);
    expect(key('café')).toBe(k);
  });
  it('keeps emoji and right-to-left text exactly in the name', () => {
    expect(parseTagName('🔥')).toMatchObject({ ok: true, name: '🔥' });
    expect(parseTagName('مهم')).toMatchObject({ ok: true, name: 'مهم', key: 'مهم' });
  });
});
