import { describe, expect, it } from 'vitest';
import { missingPermissionText, safeAuthorizationUrl } from './oauth';

describe('safeAuthorizationUrl', () => {
  it('accepts the facebook dialog', () => {
    expect(
      safeAuthorizationUrl('https://www.facebook.com/v26.0/dialog/oauth?state=x')?.host,
    ).toBe('www.facebook.com');
  });
  it.each([
    'javascript:alert(1)',
    'https://evil.example/',
    'http://www.facebook.com/',
    'https://www.facebook.com.evil.example/',
    'https://user@www.facebook.com@evil.example/',
    'not a url',
    42,
    null,
  ])('rejects %s', (u) => expect(safeAuthorizationUrl(u)).toBeNull());
});

describe('missingPermissionText', () => {
  it('maps known scopes and drops unknown values', () => {
    expect(missingPermissionText('pages_messaging,<script>,pages_show_list')).toEqual([
      'Send private replies (pages_messaging)',
      'See the Pages you manage (pages_show_list)',
    ]);
    expect(missingPermissionText(null)).toEqual([]);
  });
  it('ignores inherited object keys', () => {
    expect(missingPermissionText('constructor,__proto__,toString')).toEqual([]);
  });
});
