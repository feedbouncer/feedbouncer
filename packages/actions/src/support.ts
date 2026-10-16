import { safeOutcomeCode, resolveConstraints, type ActionStatus } from '@feedbouncer/comments';
import type { ConnectorCapabilities, Platform } from '@feedbouncer/connectors';
import { MODERATION_KIND, type ActionStep, type StepStatus, type StepType } from './steps.js';
import { worstCaseLength } from './templates.js';

export interface BrandConnectionInfo {
  connectionId: string;
  platform: Platform;
  grantedScopes: readonly string[];
  caps: ConnectorCapabilities;
}

export type StepSupport =
  | { supported: true; missingScopes: string[]; maxChars: number | null }
  | { supported: false };

const REPLY_STEPS: ReadonlySet<StepType> = new Set(['auto_reply', 'private_reply']);

export function stepSupport(step: StepType, c: BrandConnectionInfo): StepSupport {
  if (step === 'flag_for_review') return { supported: true, missingScopes: [], maxChars: null };
  const kind = MODERATION_KIND[step];
  const isReply = REPLY_STEPS.has(step);
  const available = isReply
    ? (c.caps.responses ?? []).some((k) => k === kind)
    : c.caps.actions.some((a) => a === kind);
  if (!available) return { supported: false };
  const needed =
    c.caps.actionScopes?.[kind as keyof NonNullable<ConnectorCapabilities['actionScopes']>] ?? [];
  const granted = new Set(c.grantedScopes);
  return {
    supported: true,
    missingScopes: needed.filter((s) => !granted.has(s)),
    maxChars: isReply
      ? resolveConstraints(c.caps).maxReplyChars[kind as 'public_reply' | 'private_reply']
      : null,
  };
}

export interface StepIssue {
  index: number;
  type: StepType;
  code: 'not_supported_anywhere' | 'template_too_long';
  platform?: Platform;
  max?: number;
}
export interface StepWarning {
  type: StepType;
  code: 'not_supported_on_platform' | 'missing_permission';
  platform: Platform;
  connectionId: string;
  scopes?: string[];
}

const PREVIEW_PLATFORMS: readonly Platform[] = ['facebook', 'instagram'];

/**
 * `onlyPlatform` is the platform of an author rule. With no connection on the
 * platforms in scope, capabilities come from `registryCaps` and only errors are
 * reported (there is no connection to warn about).
 */
export function checkStepsForBrand(
  steps: readonly ActionStep[],
  conns: readonly BrandConnectionInfo[],
  onlyPlatform?: Platform,
  registryCaps?: (p: Platform) => ConnectorCapabilities | undefined,
): { errors: StepIssue[]; warnings: StepWarning[] } {
  const errors: StepIssue[] = [];
  const warnings: StepWarning[] = [];
  let scope = onlyPlatform ? conns.filter((c) => c.platform === onlyPlatform) : [...conns];
  const preview = scope.length === 0;
  if (preview) {
    scope = (onlyPlatform ? [onlyPlatform] : PREVIEW_PLATFORMS).flatMap((platform) => {
      const caps = registryCaps?.(platform);
      return caps ? [{ connectionId: '', platform, grantedScopes: caps.defaultScopes, caps }] : [];
    });
    if (scope.length === 0) return { errors, warnings };
  }

  steps.forEach((step, index) => {
    if (step.type === 'flag_for_review') return;
    const supports = scope.map((c) => ({ c, s: stepSupport(step.type, c) }));
    const supporting = supports.flatMap(({ c, s }) => (s.supported ? [{ c, s }] : []));
    if (supporting.length === 0) {
      errors.push({ index, type: step.type, code: 'not_supported_anywhere' });
      return;
    }
    if (!preview) {
      for (const { c, s } of supports) {
        if (!s.supported) {
          warnings.push({
            type: step.type,
            code: 'not_supported_on_platform',
            platform: c.platform,
            connectionId: c.connectionId,
          });
        } else if (s.missingScopes.length > 0) {
          warnings.push({
            type: step.type,
            code: 'missing_permission',
            platform: c.platform,
            connectionId: c.connectionId,
            scopes: s.missingScopes,
          });
        }
      }
    }
    if ('template' in step) {
      const length = worstCaseLength(step.template);
      const tooLong = new Map<Platform, number>();
      for (const { c, s } of supporting) {
        if (s.supported && s.maxChars !== null && length > s.maxChars) {
          tooLong.set(c.platform, Math.min(s.maxChars, tooLong.get(c.platform) ?? Infinity));
        }
      }
      for (const [platform, max] of tooLong) {
        errors.push({ index, type: step.type, code: 'template_too_long', platform, max });
      }
    }
  });
  return { errors, warnings };
}

export type StepOutcome = { status: Exclude<StepStatus, 'simulated'>; reason: string | null };

const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'budget_exhausted',
  'platform_throttled',
  'rate_limited',
]);
const GONE = new Set(['comment_gone', 'already_deleted']);
const SKIPPED = new Set([
  'already_hidden',
  'already_visible',
  'own_account_comment',
  'private_reply_already_sent',
]);
const NOT_APPLICABLE = new Set([
  'author_unavailable',
  'author_is_page',
  'private_reply_window_closed',
  'private_reply_nested_comment',
  'reply_to_hidden_comment',
  'own_comment_always_visible',
]);
const MISSING_PERMISSION = new Set([
  'permission_denied',
  'permission_revoked',
  'private_reply_not_permitted',
]);

export function stepOutcomeFor(
  r:
    | { kind: 'refused'; code: string }
    | { kind: 'action'; status: ActionStatus | 'deferred'; code: string | null },
): StepOutcome {
  if (r.kind === 'refused') {
    if (r.code === 'not_found') return { status: 'not_applicable', reason: 'comment_gone' };
    if (r.code === 'unsupported') return { status: 'not_supported', reason: 'unsupported' };
    return { status: 'failed', reason: safeOutcomeCode(r.code, 'failed') };
  }
  const { status, code } = r;
  if (status === 'applied') return { status: 'succeeded', reason: null };
  if (status === 'pending') return { status: 'pending', reason: null };
  if (status === 'deferred') {
    return {
      status: 'pending',
      reason: code !== null && RATE_LIMIT_CODES.has(code) ? 'rate_limited' : 'awaiting_reconnect',
    };
  }
  if (code !== null) {
    if (status === 'noop' && GONE.has(code))
      return { status: 'not_applicable', reason: 'comment_gone' };
    if (status === 'noop' && SKIPPED.has(code)) return { status: 'skipped', reason: code };
    if (status === 'not_eligible') {
      if (NOT_APPLICABLE.has(code)) return { status: 'not_applicable', reason: code };
      if (SKIPPED.has(code)) return { status: 'skipped', reason: code };
    }
    if (status === 'failed') {
      if (code === 'unsupported') return { status: 'not_supported', reason: 'unsupported' };
      if (MISSING_PERMISSION.has(code)) return { status: 'failed', reason: 'missing_permission' };
      if (code === 'not_found') return { status: 'not_applicable', reason: 'author_gone' };
    }
  }
  return { status: 'failed', reason: safeOutcomeCode(code, 'failed') };
}

/**
 * Every reason code this package maps or emits itself; web copy tests cover each one.
 * Unknown reasons are passed through (safeOutcomeCode), so consumers must tolerate them.
 */
export const REASON_CODES: readonly string[] = [
  // outcome mapping
  'comment_gone',
  'already_hidden',
  'already_visible',
  'author_unavailable',
  'author_is_page',
  'private_reply_window_closed',
  'private_reply_nested_comment',
  'reply_to_hidden_comment',
  'own_account_comment',
  'own_comment_always_visible',
  'private_reply_already_sent',
  'ban_limit_reached',
  'reblock_too_soon',
  'author_not_bannable',
  'unsupported',
  'missing_permission',
  'author_gone',
  'text_too_long',
  'reply_too_long',
  'rate_limited',
  'awaiting_reconnect',
  // settling and fallbacks
  'rate_limit_exhausted',
  'retries_exhausted',
  'connection_needs_reconnect',
  'connection_inactive',
  'request_key_conflict',
  'failed',
  // prechecks and runner
  'moderator_override',
  'reply_thread_limit',
  'duplicate',
  'already_flagged',
  'would_run',
  'internal_error',
  // step conflicts and schema
  'duplicate_step',
  'reply_to_deleted_comment',
  'message_to_banned_author',
  'hide_redundant_with_delete',
  // brand checks
  'not_supported_anywhere',
  'not_supported_on_platform',
  'template_too_long',
];

/** A page of 100 plus the one extra row callers fetch to know whether another page follows. */
const MAX_PAGE_SIZE = 101;

/** A row count within 1..101; anything non-numeric becomes 1. */
export const clampLimit = (n: number): number =>
  Math.min(Math.max(Math.trunc(n) || 1, 1), MAX_PAGE_SIZE);
