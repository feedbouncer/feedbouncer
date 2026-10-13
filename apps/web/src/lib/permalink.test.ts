import { describe, expect, it } from 'vitest';
import { facebookPermalink } from './permalink';

describe('facebookPermalink', () => {
  it.each([
    'https://facebook.com/page/posts/1',
    'https://www.facebook.com/page/posts/1?comment_id=2',
    'https://m.facebook.com/x',
  ])('accepts %s', (u) => {
    expect(facebookPermalink(u)).toBe(u);
  });

  it.each([
    null,
    '',
    'http://www.facebook.com/x',
    'javascript:alert(1)',
    'https://evil.com/x',
    'https://facebook.com.evil.com/x',
    'https://evilfacebook.com/x',
    'https://www.facebook.com@evil.com/x',
    'https://user:pw@www.facebook.com/x',
    'https://facebook.com:8443/x',
    'not a url',
  ])('rejects %s', (u) => {
    expect(facebookPermalink(u)).toBeNull();
  });
});
