import { ApiRequestError, apiFetch } from './api-client';
import { CATEGORY_LABEL, type Category } from './classifier';
import { outcomeSentence } from './messages';
import { platformLabel } from './actions';
import { isUuid } from './ids';

export type HiddenRowState =
  | 'hidden'
  | 'pending'
  | 'restored'
  | 'already_visible'
  | 'unavailable'
  | 'failed';

export type HiddenSource =
  | { type: 'rule'; ruleId: string | null; ruleName: string | null }
  | { type: 'classifier'; category: string | null }
  | { type: 'policy'; policyId: string | null; policyName: string | null }
  | { type: 'person'; userName: string | null }
  | { type: 'suggestion'; userName: string | null }
  | { type: 'system' };

export interface HiddenItemDto {
  hideActionId: string;
  organizationId: string;
  organizationName: string;
  brandId: string;
  brandName: string;
  connectionId: string;
  connectionName: string;
  connectionStatus: string;
  platform: string;
  commentId: string;
  commentBody: string;
  commentState: 'visible' | 'hidden' | 'deleted';
  authorName: string | null;
  hiddenAt: string;
  source: HiddenSource;
  reason: string | null;
  lastAttempt: {
    actionId: string;
    status: 'pending' | 'applied' | 'noop' | 'not_eligible' | 'failed';
    outcomeCode: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
  state: HiddenRowState;
  canUnhide: boolean;
  history: {
    kind: 'hide' | 'unhide';
    actorType: string;
    actorName: string | null;
    status: string;
    outcomeCode: string | null;
    at: string;
  }[];
}

export interface BrandDayDto {
  organizationId: string;
  brandId: string;
  brandName: string;
  timezone: string;
  timezoneSet: boolean;
  dayStart: string;
}

export interface HiddenTodayPage {
  items: HiddenItemDto[];
  next: { before: string; beforeId: string } | null;
  brands: BrandDayDto[];
}

const FALLBACK_CATEGORY = 'Flagged content';

export function categoryLabel(code: string | null): string {
  return code !== null && Object.hasOwn(CATEGORY_LABEL, code)
    ? CATEGORY_LABEL[code as Category]
    : FALLBACK_CATEGORY;
}

export function sourceText(s: HiddenSource): string {
  switch (s.type) {
    case 'rule':
      return s.ruleName === null ? 'Rule (deleted)' : `Rule: ${s.ruleName}`;
    case 'classifier':
      return `AI classifier: ${categoryLabel(s.category)}`;
    case 'policy':
      return s.policyName === null ? 'Policy (deleted)' : `Policy: ${s.policyName}`;
    case 'person':
      return s.userName === null ? 'Hidden by a teammate' : `Hidden by ${s.userName}`;
    case 'suggestion':
      return s.userName === null
        ? 'Suggestion approved by a teammate'
        : `Suggestion approved by ${s.userName}`;
    case 'system':
      return 'FeedBouncer';
  }
}

/** Why it was hidden, one line each. Never empty. */
export function reasonLines(i: HiddenItemDto): string[] {
  const { source, reason } = i;
  const lines: string[] = [];
  if (source.type === 'rule' && source.ruleName !== null)
    lines.push(`Matched your rule '${source.ruleName}'`);
  if (reason !== null && reason !== '') lines.push(reason);
  if (lines.length > 0) return lines;
  return [source.type === 'person' ? 'Hidden manually' : 'Reason not recorded'];
}

/** The outcome of an unhide, or null while the comment is still hidden. */
export function stateText(i: HiddenItemDto): { label: string; detail: string | null } | null {
  const platform = platformLabel(i.platform);
  switch (i.state) {
    case 'hidden':
      return null;
    case 'restored':
      return { label: 'Restored', detail: null };
    case 'already_visible':
      return { label: 'Already visible', detail: `It was already visible on ${platform}.` };
    case 'unavailable':
      return { label: 'No longer available', detail: `This comment was deleted on ${platform}.` };
    case 'pending':
      return {
        label: 'Pending',
        detail:
          i.lastAttempt?.outcomeCode === 'awaiting_reconnect'
            ? 'Waiting for you to reconnect this account.'
            : `${platform} is slow to respond. We'll keep trying.`,
      };
    case 'failed': {
      const code = i.lastAttempt?.outcomeCode;
      return {
        label: "Couldn't unhide",
        detail: code ? outcomeSentence(code, i.platform) : null,
      };
    }
  }
}

const GENERIC_ERROR = "Couldn't unhide, try again.";

export function unhideErrorText(err: unknown): { text: string; reconnect: boolean } {
  if (err instanceof ApiRequestError && err.status === 409) {
    if (err.code === 'connection_needs_reconnect')
      return { text: 'Reconnect your account to unhide this comment.', reconnect: true };
    if (err.code === 'connection_inactive')
      return {
        text: 'This account is disconnected. Reconnect it to unhide comments.',
        reconnect: true,
      };
    if (err.code === 'missing_permission')
      return {
        text: `FeedBouncer doesn't have the "${err.permission ?? 'required'}" permission for this account. Reconnect and allow it to unhide comments.`,
        reconnect: true,
      };
  }
  return { text: GENERIC_ERROR, reconnect: false };
}

export function hiddenTodayHref(cursor: { before: string; beforeId: string } | null): string {
  if (!cursor) return '/hidden-today';
  const q = new URLSearchParams({ before: cursor.before, beforeId: cursor.beforeId });
  return `/hidden-today?${q.toString()}`;
}

function itemPath(orgId: string, brandId: string, hideActionId: string) {
  if (!isUuid(orgId) || !isUuid(brandId) || !isUuid(hideActionId)) throw new Error('Invalid id');
  return `/api/v1/orgs/${orgId}/brands/${brandId}/hidden-comments/${hideActionId}` as const;
}

export async function unhide(
  orgId: string,
  brandId: string,
  hideActionId: string,
): Promise<HiddenItemDto> {
  const res = await apiFetch<{ item: HiddenItemDto }>(
    `${itemPath(orgId, brandId, hideActionId)}/unhide`,
    { method: 'POST', body: {} },
  );
  return res.item;
}

export async function pollItem(
  orgId: string,
  brandId: string,
  hideActionId: string,
): Promise<HiddenItemDto> {
  return (await apiFetch<{ item: HiddenItemDto }>(itemPath(orgId, brandId, hideActionId))).item;
}
