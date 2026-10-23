import { describe, expect, it } from 'vitest';
import {
  VISITOR_COOKIE,
  clearVisitorCookieHeader,
  readVisitorToken,
  visitorCookieHeader,
} from './visitor.js';

const TOKEN = 'A'.repeat(42) + 'b';
const OTHER = 'c'.repeat(43);

describe('readVisitorToken', () => {
  it('reads the exact cookie name among others', () => {
    expect(readVisitorToken(`a=1; ${VISITOR_COOKIE}=${TOKEN}; b=2`)).toBe(TOKEN);
  });

  it('ignores look-alike names', () => {
    expect(readVisitorToken(`x${VISITOR_COOKIE}=${TOKEN}`)).toBeNull();
    expect(readVisitorToken(`${VISITOR_COOKIE}x=${TOKEN}`)).toBeNull();
    expect(readVisitorToken(`${VISITOR_COOKIE.toUpperCase()}=${TOKEN}`)).toBeNull();
  });

  it('rejects malformed values', () => {
    for (const v of ['', 'short', TOKEN + 'x', TOKEN.slice(1) + '=', TOKEN.slice(1) + '.']) {
      expect(readVisitorToken(`${VISITOR_COOKIE}=${v}`), v).toBeNull();
    }
    expect(readVisitorToken(undefined)).toBeNull();
    expect(readVisitorToken('')).toBeNull();
  });

  it('returns the first exact match when the name repeats', () => {
    expect(readVisitorToken(`${VISITOR_COOKIE}=${TOKEN}; ${VISITOR_COOKIE}=${OTHER}`)).toBe(TOKEN);
    expect(readVisitorToken(`${VISITOR_COOKIE}=bad; ${VISITOR_COOKIE}=${OTHER}`)).toBeNull();
  });
});

describe('visitorCookieHeader', () => {
  it('sets the cookie attributes, Secure only when asked', () => {
    const plain = visitorCookieHeader(TOKEN, false);
    expect(plain.startsWith(`${VISITOR_COOKIE}=${TOKEN};`)).toBe(true);
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) {
      expect(plain).toContain(attr);
    }
    expect(plain).not.toContain('Secure');
    expect(visitorCookieHeader(TOKEN, true)).toContain('; Secure');
  });

  it('clears with Max-Age=0', () => {
    const h = clearVisitorCookieHeader(true);
    expect(h.startsWith(`${VISITOR_COOKIE}=;`)).toBe(true);
    expect(h).toContain('Max-Age=0');
    expect(h).toContain('; Secure');
    expect(clearVisitorCookieHeader(false)).not.toContain('Secure');
  });
});
