export const SCAN_REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'ads_read',
] as const;
export const SCAN_OPTIONAL_SCOPES = ['instagram_basic', 'instagram_manage_comments'] as const;

export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return SCAN_REQUIRED_SCOPES.filter((s) => !have.has(s));
}
