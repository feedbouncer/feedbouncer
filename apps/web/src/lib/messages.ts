const MESSAGES: Record<string, string> = {
  invalid_request: 'Check the details and try again.',
  invalid_origin: 'This request was blocked. Reload the page and try again.',
  not_found: 'Not found.',
  internal_error: 'Something went wrong.',
  invalid_email: 'Enter a valid email address.',
  password_too_short: 'Use at least 12 characters.',
  password_too_long: 'Use at most 128 characters.',
  weak_password: 'This password is too easy to guess. Try a longer phrase.',
  invalid_credentials: 'Email or password is incorrect.',
  invalid_or_expired_token: 'This link is invalid or has expired. Request a new one.',
  unauthenticated: 'Log in to continue.',
  forbidden: 'You do not have permission to do this.',
  email_not_verified: 'Verify your email address first.',
  sole_owner: 'You are the only owner of an organization. Transfer ownership first.',
  last_owner: 'An organization needs at least one owner. Make someone else an owner first.',
  cannot_act_on_owner: 'Only an owner can change or remove an owner.',
  cannot_grant_owner: 'Only an owner can grant the owner role.',
  confirmation_mismatch: 'Type the organization name exactly to confirm.',
  brand_name_taken: 'A brand with this name already exists in this organization.',
  brand_archived: 'Archived brands cannot be renamed.',
  invitation_email_mismatch: 'This invitation was sent to a different email address.',
  invitation_not_pending: 'This invitation is no longer pending.',
  rate_limited: 'Too many attempts. Try again later.',
  temporarily_unavailable: 'Temporarily unavailable. Try again shortly.',
  platform_not_configured: 'This platform is not available.',
  platform_error: 'Facebook could not be reached. Try again shortly.',
  connection_needs_reconnect: 'This connection needs to be reconnected first.',
  connection_inactive: 'This connection is not active. Reconnect it and try again.',
  unsupported_action: 'This action is not supported for this platform.',
  request_key_conflict: 'This request was already used for a different action. Try again.',
  service_unavailable: 'Service temporarily unavailable. Try again shortly.',
  // Where Facebook sends the browser back after sign-in.
  denied: 'Facebook access was not granted. Nothing was connected.',
  missing_permissions:
    'FeedBouncer needs every permission below to moderate your Page. Nothing was connected.',
  account_mismatch: 'You signed in to a different Facebook account than the one this connection uses.',
  oauth_rejected: 'This sign-in could not be used. Connect again.',
};

// Outcome codes of a moderation action or a Page connection attempt.
const OUTCOMES: Record<string, string> = {
  already_hidden: 'already hidden',
  already_visible: 'already visible',
  already_deleted: 'already deleted',
  comment_gone: 'the comment no longer exists',
  own_account_comment: 'this comment was written by your own Page',
  author_is_page: 'the author is your own Page',
  author_unavailable: 'the author could not be identified',
  author_not_bannable: 'Facebook does not allow banning this author',
  ban_limit_reached: 'the Page has reached its ban limit',
  reblock_too_soon: 'this author was unbanned too recently to ban again',
  private_reply_window_closed: 'the private reply window has closed',
  private_reply_already_sent: 'a private reply was already sent',
  connected_elsewhere: 'already connected in another FeedBouncer workspace',
  not_eligible: 'you need a role that can moderate this Page',
  not_found: 'this Page was not found in your Facebook account',
  connection_inactive: 'this connection is not active',
};

const STATUS_REASONS: Record<string, string> = {
  oauth_not_refreshable: 'Facebook access was lost or expired. Reconnect to resume moderation.',
  oauth_access_rejected: 'Facebook access was lost or expired. Reconnect to resume moderation.',
  page_role_lost: 'You no longer have a moderator role on this Page.',
};

const own = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export function messageFor(code: string): string {
  return own(MESSAGES, code) ?? 'Something went wrong.';
}

export function outcomeText(code: string): string {
  return own(OUTCOMES, code) ?? 'it could not be completed';
}

export function statusReasonText(code: string | null): string | null {
  if (code === null) return null;
  return own(STATUS_REASONS, code) ?? 'This connection needs attention.';
}
