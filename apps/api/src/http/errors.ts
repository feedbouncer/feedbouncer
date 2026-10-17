// Every error response has one shape: { error: { code, message } }. Codes are
// stable API contract; messages are plain sentences safe to show a user and
// never contain request values, SQL, stack traces or secrets.
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_cursor'
  | 'invalid_origin'
  | 'not_found'
  | 'internal_error'
  | 'invalid_email'
  | 'password_too_short'
  | 'password_too_long'
  | 'weak_password'
  | 'invalid_credentials'
  | 'invalid_or_expired_token'
  | 'unauthenticated'
  | 'forbidden'
  | 'email_not_verified'
  | 'sole_owner'
  | 'last_owner'
  | 'cannot_act_on_owner'
  | 'cannot_grant_owner'
  | 'confirmation_mismatch'
  | 'brand_name_taken'
  | 'brand_archived'
  | 'invitation_email_mismatch'
  | 'invitation_not_pending'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'platform_not_configured'
  | 'platform_error'
  | 'connection_needs_reconnect'
  | 'connection_inactive'
  | 'missing_permission'
  | 'review_mode_active'
  | 'unsupported_action'
  | 'request_key_conflict'
  | 'text_too_long'
  | 'invalid_rule'
  | 'invalid_actions'
  | 'undo_not_available'
  | 'already_undone'
  | 'review_item_resolved'
  | 'suggestion_already_handled'
  | 'review_mode_not_active'
  | 'risk_not_acknowledged'
  | 'confirmation_required'
  | 'rule_limit_reached'
  | 'rule_order_mismatch'
  | 'invalid_domain'
  | 'domain_exists'
  | 'domain_limit_reached'
  | 'invalid_classifier_settings'
  | 'classifier_rerun_too_soon'
  | 'invalid_policy'
  | 'policy_limit_reached'
  | 'policy_name_taken'
  | 'policy_quota_exhausted'
  | 'policy_preview_in_progress'
  | 'policy_run_too_soon'
  | 'policy_not_enabled'
  | 'policy_evaluation_unavailable'
  | 'service_unavailable'
  | 'invalid_tag_name'
  | 'tag_name_taken'
  | 'tag_limit_reached'
  | 'tag_count_changed'
  | 'unknown_tag';

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  invalid_request: 'The request is not valid.',
  invalid_cursor: 'The page cursor is not valid.',
  invalid_origin: 'Request origin is not allowed.',
  not_found: 'Not found.',
  internal_error: 'Something went wrong.',
  invalid_email: 'Enter a valid email address.',
  password_too_short: 'Use at least 12 characters.',
  password_too_long: 'Use at most 128 characters.',
  weak_password: 'This password is too easy to guess. Try a longer phrase.',
  invalid_credentials: 'Email or password is incorrect.',
  invalid_or_expired_token: 'This link is invalid or has expired. Request a new one.',
  unauthenticated: 'Sign in to continue.',
  forbidden: 'You do not have permission to do this.',
  email_not_verified: 'Verify your email address first.',
  sole_owner: 'You are the only owner of an organization. Transfer ownership or delete it first.',
  last_owner: 'An organization needs at least one owner. Make someone else an owner first.',
  cannot_act_on_owner: 'Only an owner can change or remove an owner.',
  cannot_grant_owner: 'Only an owner can grant the owner role.',
  confirmation_mismatch: 'Type the organization name exactly to confirm.',
  brand_name_taken: 'A brand with this name already exists in this organization.',
  brand_archived: 'Archived brands cannot be changed.',
  invitation_email_mismatch: 'This invitation was sent to a different email address.',
  invitation_not_pending: 'This invitation is no longer pending.',
  rate_limited: 'Too many attempts. Try again later.',
  temporarily_unavailable: 'Temporarily unavailable. Try again shortly.',
  platform_not_configured: 'This platform is not available.',
  platform_error: 'The platform could not be reached. Try again shortly.',
  connection_needs_reconnect: 'This connection needs to be reconnected first.',
  connection_inactive: 'This connection is not active.',
  missing_permission: 'Missing platform permission.',
  review_mode_active:
    'Review mode is on for this connection; automation can only suggest this action.',
  unsupported_action: 'This action is not supported for this platform.',
  request_key_conflict: 'This request key was already used for a different action.',
  text_too_long: 'Reply is too long for this platform.',
  invalid_rule: 'The rule is not valid.',
  invalid_actions: 'The rule actions are not valid.',
  undo_not_available: 'This step cannot be undone.',
  already_undone: 'This step was already undone.',
  review_item_resolved: 'This item was already resolved.',
  suggestion_already_handled: 'This suggestion was already handled.',
  review_mode_not_active: 'Review mode is not on for this connection.',
  risk_not_acknowledged: 'Confirm that you understand the risk of starting without review mode.',
  confirmation_required: 'Confirm this action to continue.',
  rule_limit_reached: 'This brand has reached the maximum number of rules.',
  rule_order_mismatch: 'The order must list every rule of the brand exactly once.',
  invalid_domain: 'Enter a valid domain name.',
  domain_exists: 'This domain is already in the list.',
  domain_limit_reached: 'This brand has reached the maximum number of own domains.',
  invalid_classifier_settings: 'The classifier settings are not valid.',
  classifier_rerun_too_soon: 'A re-run was requested recently. Try again in a few minutes.',
  invalid_policy: 'The policy is not valid.',
  policy_limit_reached: 'This brand already has the maximum number of policies.',
  policy_name_taken: 'Another policy already has this name.',
  policy_quota_exhausted: 'This brand has used its monthly policy checks.',
  policy_preview_in_progress: 'A preview is already running for this brand.',
  policy_run_too_soon: 'Policies were applied to recent comments less than 15 minutes ago.',
  policy_not_enabled: 'Enable the policy before applying it to recent comments.',
  policy_evaluation_unavailable: 'Policy checks are turned off in this deployment.',
  service_unavailable: 'Service temporarily unavailable. Try again shortly.',
  invalid_tag_name: 'Enter a tag name of 1 to 50 characters without control characters.',
  tag_name_taken: 'A tag with this name already exists.',
  tag_limit_reached: 'This workspace has the maximum number of tags.',
  tag_count_changed: 'The number of comments with this tag changed. Confirm again.',
  unknown_tag: 'A tag no longer exists.',
};

export interface ErrorIssue {
  path: string;
  message: string;
  platform?: string;
  max?: number;
}

/** Who already decided a suggestion, for a 409 suggestion_already_handled. */
export interface HandledDetails {
  status: string;
  decidedAt: string | null;
  decidedByName: string | null;
}

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message?: string,
    /** Specifics merged into the envelope: schema problems or a limit, never request values. */
    readonly details?: {
      readonly issues?: readonly ErrorIssue[];
      readonly max?: number;
      readonly handled?: HandledDetails;
      /** The platform permission a connection lacks, for 409 missing_permission. */
      readonly permission?: string;
      /** Why a tag name was refused, for 400 invalid_tag_name. */
      readonly reason?: string;
      /** The existing tag, for 409 tag_name_taken. */
      readonly tag?: unknown;
      /** The current number of comments with the tag, for 409 tag_count_changed. */
      readonly count?: number;
    },
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
  }
}

export const notFound = (): ApiError => new ApiError(404, 'not_found');

export function errorBody(e: ApiError): {
  error: {
    code: ErrorCode;
    message: string;
    issues?: readonly ErrorIssue[];
    max?: number;
    handled?: HandledDetails;
    permission?: string;
    reason?: string;
    tag?: unknown;
    count?: number;
  };
} {
  return { error: { ...e.details, code: e.code, message: e.message } };
}

// Maps anything thrown in Nest (or by Fastify before a handler, which Nest
// wraps in an HttpException) to the envelope. HttpException texts are not
// forwarded: they can quote request input (e.g. JSON parse errors).
function toApiError(err: unknown): ApiError | undefined {
  if (err instanceof ApiError) return err;
  if (!(err instanceof HttpException)) return undefined;
  const status = err.getStatus();
  if (status === 404) return notFound();
  if (status === 413) return new ApiError(413, 'invalid_request', 'Request body too large.');
  if (status === 415) return new ApiError(415, 'invalid_request', 'Unsupported content type.');
  if (status >= 400 && status < 500) return new ApiError(400, 'invalid_request');
  return undefined;
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let e = toApiError(err);
    if (!e) {
      this.log.error('unhandled error', errorFields(err));
      e = new ApiError(500, 'internal_error');
    }
    void reply.status(e.status).header('cache-control', 'no-store').send(errorBody(e));
  }
}
