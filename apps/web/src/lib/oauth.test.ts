import { describe, expect, it } from 'vitest';
import { missingPermissionText, safeAuthorizationUrl } from './oauth';

describe('safeAuthorizationUrl', () => {
  it('accepts the facebook dialog', () => {
    expect(safeAuthorizationUrl('https://www.facebook.com/v26.0/dialog/oauth?state=x')?.host).toBe(
      'www.facebook.com',
    );
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

describe('instagram scopes', () => {
  it('describes the Instagram permissions', () => {
    expect(
      missingPermissionText('instagram_basic,instagram_manage_comments,instagram_manage_messages'),
    ).toEqual([
      "See your Instagram account's basic info (instagram_basic)",
      'Read, hide, delete and reply to comments (instagram_manage_comments)',
      'Send one private reply to a commenter (instagram_manage_messages)',
    ]);
  });
  it.each(['https://www.instagram.com/oauth/authorize', 'https://api.instagram.com/oauth'])(
    'still only allows the facebook dialog host: rejects %s',
    (u) => expect(safeAuthorizationUrl(u)).toBeNull(),
  );
});

describe('tiktok', () => {
  it('accepts the TikTok and TikTok for Business consent pages', () => {
    for (const u of [
      'https://www.tiktok.com/v2/auth/authorize/?state=x',
      'https://business-api.tiktok.com/portal/auth?state=x',
    ])
      expect(safeAuthorizationUrl(u)?.href).toBe(u);
    for (const u of [
      'http://www.tiktok.com/v2/auth/authorize/',
      'https://www.tiktok.com.evil.example/',
      'https://ads.tiktok.com/',
    ])
      expect(safeAuthorizationUrl(u)).toBeNull();
  });
  it('describes the TikTok permissions', () => {
    expect(missingPermissionText('comment.list,comment.list.manage')).toEqual([
      'Read comments on your videos (comment.list)',
      'Hide, delete and reply to comments (comment.list.manage)',
    ]);
  });
});

describe('youtube', () => {
  it('accepts only the Google consent page over https', () => {
    const u = 'https://accounts.google.com/o/oauth2/v2/auth?state=x';
    expect(safeAuthorizationUrl(u)?.href).toBe(u);
    for (const bad of [
      'http://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com.evil.example/',
      'https://www.google.com/',
    ])
      expect(safeAuthorizationUrl(bad)).toBeNull();
  });
  it('describes the YouTube permission', () => {
    expect(missingPermissionText('youtube.force-ssl')).toEqual([
      'Read comments, hold them for review and reject them (youtube.force-ssl)',
    ]);
  });
});

describe('threads', () => {
  it.each(['https://threads.com/oauth/authorize?state=x', 'https://threads.net/oauth/authorize'])(
    'accepts the Threads consent page %s',
    (u) => expect(safeAuthorizationUrl(u)?.href).toBe(u),
  );
  it('rejects look-alike hosts', () => {
    expect(safeAuthorizationUrl('https://threads.com.evil.example/')).toBeNull();
    expect(safeAuthorizationUrl('http://threads.com/')).toBeNull();
  });
  it('describes the Threads permissions', () => {
    expect(missingPermissionText('threads_read_replies,threads_manage_replies')).toEqual([
      'Read replies to your posts (threads_read_replies)',
      'Hide, unhide and post replies (threads_manage_replies)',
    ]);
  });
});
