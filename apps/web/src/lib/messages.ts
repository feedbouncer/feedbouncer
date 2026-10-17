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
  brand_archived: 'Archived brands cannot be changed.',
  invitation_email_mismatch: 'This invitation was sent to a different email address.',
  invitation_not_pending: 'This invitation is no longer pending.',
  rate_limited: 'Too many attempts. Try again later.',
  alerts_unavailable: "Alerts aren't set up on this server.",
  invalid_webhook_url: 'Enter a Slack incoming webhook URL (https://hooks.slack.com/services/...).',
  email_taken: 'This address is already a recipient.',
  too_soon: 'A confirmation was sent a moment ago. Try again in a minute.',
  unknown_channel: 'One of the channels no longer exists. Reload the page.',
  confirmation_send_failed: "The confirmation email couldn't be sent. Try Resend.",
  temporarily_unavailable: 'Temporarily unavailable. Try again shortly.',
  platform_not_configured: "This platform isn't set up on this FeedBouncer server.",
  platform_error: 'The platform could not be reached. Try again.',
  connection_needs_reconnect: 'This connection needs to be reconnected first.',
  connection_inactive: 'This connection is not active. Reconnect it and try again.',
  missing_permission:
    "FeedBouncer doesn't have the permission it needs for this account. Reconnect and allow it.",
  unsupported_action: 'This action is not supported for this platform.',
  request_key_conflict: 'This request was already used for a different action. Try again.',
  service_unavailable: 'Service temporarily unavailable. Try again shortly.',
  text_too_long: 'Reply is too long for this platform.',
  invalid_actions: 'Some actions of this rule have problems. Fix them and try again.',
  undo_not_available: 'This step cannot be undone.',
  already_undone: 'This step was already undone.',
  review_item_resolved: 'This item was already resolved.',
  confirmation_required: 'Confirm this action to continue.',
  suggestion_already_handled: 'This suggestion was already handled.',
  review_mode_not_active: 'Review mode has already ended for this account.',
  risk_not_acknowledged: 'Confirm that you understand the risk before turning review mode off.',
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
  invalid_tag_name: 'Enter a tag name of 1 to 50 characters without control characters.',
  tag_name_taken: 'A tag with this name already exists.',
  tag_limit_reached: 'This workspace has reached its tag limit.',
  tag_count_changed: 'The number of comments with this tag changed. Confirm again.',
  unknown_tag: 'A tag was deleted. Reload the page and try again.',
  invalid_timezone: 'Choose a valid time zone.',
  invalid_week: 'Choose a past week from the last year.',
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
  already_flagged: 'already in the review queue',
  author_gone: 'the author no longer exists',
  missing_permission: 'FeedBouncer lacks the permission for this action',
  rate_limited: 'the platform asked FeedBouncer to slow down',
  rate_limit_exhausted: 'the platform kept refusing because of rate limits',
  retries_exhausted: 'it kept failing after several tries',
  awaiting_reconnect: 'waiting for the connection to be reconnected',
  request_key_conflict: 'this request was already used for a different action',
  failed: 'the platform did not accept it',
  moderator_override: 'a team member reversed this earlier, so it was not repeated',
  reply_thread_limit: 'this thread already has an automatic reply',
  duplicate: 'the same step already ran for this comment',
  would_run: 'this step would run',
  already_banned: 'this author was already banned',
  approver_removed: 'the person who approved this is no longer on the team',
  review_mode_active: 'review mode is on, so this is suggested for approval instead',
  internal_error: 'something went wrong on our side',
  duplicate_step: 'each step can be used once',
  not_supported_anywhere: 'none of the connected accounts support this',
  not_supported_on_platform: 'not available on this platform',
  template_too_long: 'the reply is too long for this platform',
  reply_to_deleted_comment: 'a comment that is being deleted cannot be replied to',
  message_to_banned_author: 'an author who is being banned cannot be messaged',
  hide_redundant_with_delete: 'delete already removes the comment, so hiding it adds nothing',
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

/** Whether `code` is a known outcome code, as opposed to an API error code. */
export const isOutcomeCode = (code: string): boolean =>
  Object.hasOwn(OUTCOMES, code) || INSTAGRAM_ERROR.test(code);

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
