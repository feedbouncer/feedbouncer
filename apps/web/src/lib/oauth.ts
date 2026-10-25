const SCOPE_TEXT: Record<string, string> = {
  pages_show_list: 'See the Pages you manage',
  pages_read_engagement: 'Read Page posts and comments',
  pages_read_user_content: 'Read comments people leave on your Page',
  pages_manage_engagement: 'Hide, delete and reply to comments',
  pages_manage_metadata: 'Receive new comments in real time',
  pages_messaging: 'Send private replies',
  instagram_basic: "See your Instagram account's basic info",
  instagram_manage_comments: 'Read, hide, delete and reply to comments',
  ads_read: 'Read your ads and the comments on them',
  instagram_manage_messages: 'Send one private reply to a commenter',
  'user.info.basic': "See your TikTok account's basic info",
  'video.list': 'List your videos',
  'comment.list': 'Read comments on your videos',
  'comment.list.manage': 'Hide, delete and reply to comments',
  'youtube.force-ssl': 'Read comments, hold them for review and reject them',
  threads_basic: 'See your profile and list your posts',
  threads_read_replies: 'Read replies to your posts',
  threads_manage_replies: 'Hide, unhide and post replies',
  threads_content_publish: 'Publish the replies your rules send',
};

// Instagram is connected through Facebook Login, so its dialog is on www.facebook.com too;
// TikTok, YouTube (Google) and Threads have their own authorization hosts.
const AUTHORIZATION_HOSTS: ReadonlySet<string> = new Set([
  'www.facebook.com',
  'www.tiktok.com',
  'business-api.tiktok.com',
  'accounts.google.com',
  'threads.com',
  'threads.net',
]);

export function safeAuthorizationUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && AUTHORIZATION_HOSTS.has(u.host) ? u : null;
  } catch {
    return null;
  }
}

export function missingPermissionText(list: string | null): string[] {
  return (list ?? '')
    .split(',')
    .filter((s) => Object.hasOwn(SCOPE_TEXT, s))
    .map((s) => `${SCOPE_TEXT[s]} (${s})`);
}
