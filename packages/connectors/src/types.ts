import type { ConnectorErrorInfo } from './errors.js';

// Mirrors connection_platform_check (migration 20261011000100_tenancy).
export const PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'threads',
  'linkedin',
  'x',
  'bluesky',
] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (v: unknown): v is Platform =>
  typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v);

export const MODERATION_ACTIONS = [
  'hide',
  'unhide',
  'delete',
  'report',
  'ban_author',
  'unban_author',
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
export const INVERSE_ACTION: Readonly<Record<ModerationAction, ModerationAction | null>> = {
  hide: 'unhide',
  unhide: 'hide',
  delete: null,
  report: null,
  ban_author: 'unban_author',
  unban_author: 'ban_author',
};

export type SourceKind = 'organic_post' | 'ad_post' | 'video' | 'thread';
export type PlatformState = 'visible' | 'hidden' | 'deleted';

export interface CommentRef {
  readonly sourceExternalId: string;
  readonly externalId: string;
}
export interface NormalizedAuthor {
  readonly externalId: string;
  readonly displayName: string | null;
  readonly profileUrl: string | null;
}
export interface NormalizedComment {
  readonly externalId: string;
  readonly sourceExternalId: string;
  readonly parentExternalId: string | null;
  readonly author: NormalizedAuthor | null;
  readonly body: string;
  readonly postedAt: Date;
  readonly platformState: PlatformState;
  readonly permalink: string | null;
}
export interface NormalizedSource {
  readonly externalId: string;
  readonly kind: SourceKind;
  readonly permalink: string | null;
  readonly active: boolean;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ActionRequest {
  readonly action: ModerationAction;
  readonly target: CommentRef;
  /** The comment author's platform id; needed by author-level actions such as ban. */
  readonly authorExternalId?: string;
}
export type ActionResult =
  | {
      readonly status: 'applied';
      readonly request: ActionRequest;
      readonly platformActionId: string | null;
      readonly undo: ActionRequest | null;
    }
  | { readonly status: 'not_found'; readonly request: ActionRequest }
  | { readonly status: 'unsupported'; readonly request: ActionRequest }
  | {
      readonly status: 'failed';
      readonly request: ActionRequest;
      readonly error: ConnectorErrorInfo;
    };

export const RESPONSE_KINDS = ['public_reply', 'private_reply'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

export interface RespondRequest {
  readonly kind: ResponseKind;
  readonly target: CommentRef;
  /** Plain text, 1..8000 characters after trim. */
  readonly text: string;
}
export type RespondResult =
  | {
      readonly status: 'sent';
      readonly request: RespondRequest;
      readonly platformRef: string | null;
    }
  | { readonly status: 'not_found'; readonly request: RespondRequest }
  | { readonly status: 'not_eligible'; readonly request: RespondRequest; readonly code: string }
  | { readonly status: 'unsupported'; readonly request: RespondRequest }
  | {
      readonly status: 'failed';
      readonly request: RespondRequest;
      readonly error: ConnectorErrorInfo;
    };

export type Priority = 'urgent' | 'bulk';

export interface RateLimitPolicy {
  /** Requests allowed per window, per connected account. */
  readonly points: number;
  readonly durationSec: number;
  /** Points that bulk reads can never use, so actions are not starved. 0 <= reserve < points. */
  readonly urgentReservePoints: number;
  /** Used when the platform throttles without a retry hint. */
  readonly defaultRetryAfterMs: number;
}

/** How long after a comment is posted a platform still accepts a private reply to it (Facebook: 7 days). */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 86_400_000;

export interface ConnectorCapabilities {
  readonly actions: readonly ModerationAction[];
  readonly listSources: boolean;
  readonly ingestion: 'webhook' | 'polling' | 'webhook_and_polling';
  readonly tokens: { readonly refreshable: boolean; readonly rotatesRefreshToken: boolean };
  readonly rateLimit: RateLimitPolicy;
  /** Lowercase hostnames the connector may call (https only). */
  readonly apiHosts: readonly string[];
  /** Lowercase hostnames allowed in the authorization URL. */
  readonly authorizationHosts: readonly string[];
  readonly defaultScopes: readonly string[];
  /** Subset of `defaultScopes` without which the connection is unusable. */
  readonly requiredScopes?: readonly string[];
  /** `multiple` means the grant covers several accounts and the user picks (needs `listAccounts`). Default `single`. */
  readonly accountSelection?: 'single' | 'multiple';
  /** Response kinds `respond()` supports (needs `respond`). Default none. */
  readonly responses?: readonly ResponseKind[];
  /** 1..500 */
  readonly maxPageSize: number;
}
