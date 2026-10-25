import { describe, expect, it } from 'vitest';
import { viewOnUrl } from './permalink';

describe('viewOnUrl (facebook)', () => {
  it.each([
    'https://facebook.com/page/posts/1',
    'https://www.facebook.com/page/posts/1?comment_id=2',
    'https://m.facebook.com/x',
  ])('accepts %s', (u) => {
    expect(viewOnUrl('facebook', u)).toBe(u);
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
    expect(viewOnUrl('facebook', u)).toBeNull();
  });
});

describe('viewOnUrl (tiktok)', () => {
  it('links only to tiktok.com', () => {
    const u = 'https://www.tiktok.com/@shop/video/7300000000000000301';
    expect(viewOnUrl('tiktok', u)).toBe(u);
    expect(viewOnUrl('tiktok_ads', 'https://www.tiktok.com/@/video/1')).toBe(
      'https://www.tiktok.com/@/video/1',
    );
    expect(viewOnUrl('tiktok', 'https://tiktok.com.evil.example/x')).toBeNull();
    expect(viewOnUrl('tiktok', 'https://www.facebook.com/x')).toBeNull();
  });
});

describe('viewOnUrl (youtube)', () => {
  it('links only to youtube.com', () => {
    const u = 'https://www.youtube.com/watch?v=abcdefghijk&lc=Ugx12345678';
    expect(viewOnUrl('youtube', u)).toBe(u);
    expect(viewOnUrl('youtube', 'https://youtube.com.evil.example/x')).toBeNull();
    expect(viewOnUrl('youtube', 'https://www.facebook.com/x')).toBeNull();
  });
});

describe('viewOnUrl (threads)', () => {
  it.each([
    'https://www.threads.com/@shop/post/C1',
    'https://threads.com/@shop/post/C1',
    'https://www.threads.net/@shop/post/C1',
    'https://threads.net/@shop/post/C1',
  ])('accepts %s', (u) => {
    expect(viewOnUrl('threads', u)).toBe(u);
  });
  it.each([
    'https://threads.com.evil.example/x',
    'https://www.threads.com@evil.example/x',
    'http://www.threads.com/x',
    'https://www.instagram.com/x',
  ])('rejects %s', (u) => {
    expect(viewOnUrl('threads', u)).toBeNull();
  });
});
