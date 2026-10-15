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
  platform_not_configured: "This platform isn't set up on this FeedBouncer server.",
  platform_error: 'The platform could not be reached. Try again.',
  connection_needs_reconnect: 'This connection needs to be reconnected first.',
  connection_inactive: 'This connection is not active. Reconnect it and try again.',
  unsupported_action: 'This action is not supported for this platform.',
  request_key_conflict: 'This request was already used for a different action. Try again.',
  service_unavailable: 'Service temporarily unavailable. Try again shortly.',
  text_too_long: 'Reply is too long for this platform.',
  invalid_rule: 'This rule has problems. Fix the highlighted fields and try again.',
  rule_limit_reached: 'This brand has reached the maximum number of rules.',
  rule_order_mismatch: 'The rules changed since you opened this page. Reload and try again.',
  invalid_classifier_settings: 'Check the thresholds and try again.',
  classifier_rerun_too_soon: 'A re-run was started recently. Try again in a few minutes.',
  invalid_policy: 'This policy has problems. Fix the highlighted fields and try again.',
  policy_limit_reached: 'This brand already has the maximum number of policies.',
  policy_name_taken: 'Another policy already has this name.',
  policy_quota_exhausted: 'This brand has used its monthly policy checks.',
  policy_preview_in_progress: 'A preview is already running for this brand.',
  policy_run_too_soon: 'Policies were applied to recent comments less than 15 minutes ago.',
  policy_not_enabled: 'Enable the policy before applying it to recent comments.',
  policy_evaluation_unavailable: 'Policy checks are turned off in this deployment.',
  invalid_domain: 'Enter a valid domain name.',
  domain_exists: 'This domain is already in the list.',
  domain_limit_reached: 'This brand has reached the maximum number of own domains.',
  // Where Facebook sends the browser back after sign-in.
  denied: 'Facebook access was not granted. Nothing was connected.',
  missing_permissions:
    'FeedBouncer needs every permission below to moderate your Page. Nothing was connected.',
  account_mismatch:
    'You signed in to a different Facebook account than the one this connection uses.',
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
  connection_needs_reconnect: 'this connection needs to be reconnected first',
  // Full sentences, shown as they are.
  own_comment_always_visible: "Instagram always shows your own comments, so they can't be hidden.",
  reply_to_hidden_comment: "Instagram doesn't allow replies to hidden comments. Unhide it first.",
  private_reply_nested_comment: 'Instagram only allows private replies to top-level comments.',
  private_reply_not_permitted:
    'Private replies need the messaging permission. Reconnect and allow it.',
  reply_too_long: 'Reply is too long for this platform.',
  text_too_long: 'Reply is too long for this platform.',
  permission_revoked: 'FeedBouncer lost permission for this account. Reconnect it.',
  instagram_account_restricted:
    'Instagram has restricted this account. Open the Instagram app to resolve it.',
  unsupported: 'Not available on this platform.',
  platform_not_configured: "This platform isn't set up on this FeedBouncer server.",
};

// Outcomes whose wording differs by platform.
const PLATFORM_OUTCOMES: Record<string, Record<string, string>> = {
  instagram: {
    connected_elsewhere:
      'This Instagram account is already connected in another FeedBouncer workspace.',
  },
};

// An Instagram Graph error the connector could not classify, e.g. instagram_error_190_0.
const INSTAGRAM_ERROR = /^instagram_error_(\d{1,10})_(\d{1,10})$/;

const STATUS_REASONS: Record<string, string> = {
  oauth_not_refreshable: 'Access was lost or expired. Reconnect to resume moderation.',
  oauth_access_rejected: 'Access was lost or expired. Reconnect to resume moderation.',
  setup_not_queued:
    'The connection was saved but setup could not be started. Reconnect to finish connecting.',
  page_role_lost: 'You no longer have a moderator role on this Page.',
};

const ACTION_KINDS: Record<string, string> = {
  hide: 'Hide',
  unhide: 'Unhide',
  delete: 'Delete',
  ban_author: 'Ban author',
  unban_author: 'Unban author',
  public_reply: 'Public reply',
  private_reply: 'Private reply',
};

const ACTOR_TYPES: Record<string, string> = {
  user: 'a team member',
  rule: 'a rule',
  classifier: 'classifier',
  policy: 'a custom policy',
  system: 'the system',
};

const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export function messageFor(code: string): string {
  return own(MESSAGES, code) ?? 'Something went wrong.';
}

export function outcomeText(code: string, platform?: string): string {
  const variants = platform !== undefined ? own(PLATFORM_OUTCOMES, platform) : undefined;
  const variant = variants ? own(variants, code) : undefined;
  if (variant !== undefined) return variant;
  const known = own(OUTCOMES, code);
  if (known !== undefined) return known;
  const ig = INSTAGRAM_ERROR.exec(code);
  if (ig) return `Instagram refused this action (error ${ig[1]}/${ig[2]}).`;
  return 'it could not be completed';
}

/** outcomeText as a sentence: capitalised, ending in a full stop. */
export function outcomeSentence(code: string, platform?: string): string {
  const t = outcomeText(code, platform);
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

export function statusReasonText(code: string | null): string | null {
  if (code === null) return null;
  return own(STATUS_REASONS, code) ?? 'This connection needs attention.';
}

export function actionKindText(kind: string): string {
  return own(ACTION_KINDS, kind) ?? 'Action';
}

export function actorTypeText(actorType: string): string {
  return own(ACTOR_TYPES, actorType) ?? 'someone';
}
