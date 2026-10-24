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
};

// Instagram is connected through Facebook Login, so its dialog is on www.facebook.com too;
// TikTok has its own authorization hosts.
const AUTHORIZATION_HOSTS: ReadonlySet<string> = new Set([
  'www.facebook.com',
  'www.tiktok.com',
  'business-api.tiktok.com',
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
