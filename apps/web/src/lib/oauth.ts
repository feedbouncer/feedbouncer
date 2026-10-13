const SCOPE_TEXT: Record<string, string> = {
  pages_show_list: 'See the Pages you manage',
  pages_read_engagement: 'Read Page posts and comments',
  pages_read_user_content: 'Read comments people leave on your Page',
  pages_manage_engagement: 'Hide, delete and reply to comments',
  pages_manage_metadata: 'Receive new comments in real time',
  pages_messaging: 'Send private replies',
};

export function safeAuthorizationUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.host === 'www.facebook.com' ? u : null;
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
