import { describe, expect, it } from 'vitest';
import { isTrustedOrigin } from './origin.guard.js';

const WEB = 'http://localhost:3000';

describe('isTrustedOrigin', () => {
  it('allows safe methods without checks', () => {
    expect(isTrustedOrigin('GET', {}, WEB)).toBe(true);
    expect(isTrustedOrigin('head', { origin: 'https://evil.test' }, WEB)).toBe(true);
    expect(isTrustedOrigin('OPTIONS', {}, WEB)).toBe(true);
  });
  it('allows a matching Origin', () =>
    expect(isTrustedOrigin('POST', { origin: WEB }, WEB)).toBe(true));
  it('rejects a foreign Origin', () =>
    expect(isTrustedOrigin('POST', { origin: 'https://evil.test' }, WEB)).toBe(false));
  it('rejects look-alike origins', () => {
    expect(isTrustedOrigin('POST', { origin: 'http://localhost:3000.evil.test' }, WEB)).toBe(false);
    expect(isTrustedOrigin('POST', { origin: 'https://localhost:3000' }, WEB)).toBe(false);
    expect(isTrustedOrigin('POST', { origin: 'http://localhost:3001' }, WEB)).toBe(false);
  });
  it('rejects "null" Origin', () =>
    expect(isTrustedOrigin('POST', { origin: 'null' }, WEB)).toBe(false));
  it('rejects a foreign Origin even with Sec-Fetch-Site: same-origin', () =>
    expect(
      isTrustedOrigin(
        'POST',
        { origin: 'https://evil.test', 'sec-fetch-site': 'same-origin' },
        WEB,
      ),
    ).toBe(false));
  it('allows missing Origin only with Sec-Fetch-Site: same-origin', () => {
    expect(isTrustedOrigin('POST', {}, WEB)).toBe(false);
    expect(isTrustedOrigin('DELETE', { 'sec-fetch-site': 'same-origin' }, WEB)).toBe(true);
    expect(isTrustedOrigin('PATCH', { 'sec-fetch-site': 'cross-site' }, WEB)).toBe(false);
    expect(isTrustedOrigin('PUT', { 'sec-fetch-site': 'same-site' }, WEB)).toBe(false);
  });
});
