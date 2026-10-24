import type { ConnectorErrorInfo } from './errors.js';

// Mirrors connection_platform_check (migration 20261011000100_tenancy; meta_ads added by
// 20261015000100_meta_ads; tiktok_ads by 20261024000100_tiktok).
export const PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'threads',
  'linkedin',
  'x',
  'bluesky',
  'meta_ads',
  'tiktok_ads',
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
  /** Direct replies on this comment, when the platform reports it. */
  readonly replyCount?: number | undefined;
}
export type AdPlacementPlatform = 'facebook' | 'instagram';
export type AdUnresolvedReason =
  | 'no_post'
  | 'dynamic_creative_unsupported'
  | 'post_deleted'
  | 'invalid_platform_id'
  | 'instagram_media_pending'
  | 'not_instagram';
/** Where one ad's post lives on one platform; exactly one of `sourceExternalId` and `unresolvedReason` is set. */
export interface AdPlacement {
  readonly platform: AdPlacementPlatform;
  /** FB: Page id (prefix of the story id). IG: instagram_user_id. Null when unknown. */
  readonly accountExternalId: string | null;
  /** FB: 'PAGEID_POSTID'. IG: media id. Null when unresolved. */
  readonly sourceExternalId: string | null;
  readonly unresolvedReason: AdUnresolvedReason | null;
}
export interface AdLookup {
  readonly name: string | null;
  readonly deleted: boolean;
}
export interface AdSourceInfo {
  /** Digits only, without the `act_` prefix. */
  readonly adAccountExternalId: string;
  /** Matches `^[A-Z_]{1,40}$`. */
  readonly effectiveStatus: string;
  /** Ad name as set in Ads Manager, at most 200 code points. */
  readonly name: string | null;
  /** Exactly one 'facebook' and one 'instagram' entry. */
  readonly placements: readonly AdPlacement[];
}
export interface NormalizedSource {
  readonly externalId: string;
  readonly kind: SourceKind;
  readonly permalink: string | null;
  readonly active: boolean;
  /** Set by ad connectors: the ad this source stands for. */
  readonly ad?: AdSourceInfo | undefined;
}
export interface RecentSource {
  readonly externalId: string;
  readonly createdAt: Date;
  readonly permalink: string | null;
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

/** `background` (ad polling and discovery) is capped below `bulk`; see RateBudget. */
export type Priority = 'urgent' | 'bulk' | 'background';

export interface RateLimitPolicy {
  /** Requests allowed per window, per connected account. */
  readonly points: number;
  readonly durationSec: number;
  /** Points that bulk reads can never use, so actions are not starved. 0 <= reserve < points. */
  readonly urgentReservePoints: number;
  /** Used when the platform throttles without a retry hint. */
  readonly defaultRetryAfterMs: number;
  /** Points `background` work may use per window. Default floor((points - urgentReservePoints) / 2), min 1. */
  readonly backgroundPoints?: number;
}

/** How long after a comment is posted a platform still accepts a private reply to it (Facebook: 7 days). */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 86_400_000;

/** Per-platform limits on moderation actions. Every member is optional; absent means the default. */
export interface ActionConstraints {
  /** Default PRIVATE_REPLY_WINDOW_MS (7 days). */
  readonly privateReplyWindowMs?: number;
  /** Default false. Instagram: true. */
  readonly privateReplyTopLevelOnly?: boolean;
  /** Default true. Instagram: false ("cannot reply to hidden comments"). */
  readonly publicReplyOnHidden?: boolean;
  /** Default true. Instagram: false (owner's own comments are always displayed). */
  readonly hideOwnAccountComments?: boolean;
  /** Max code points per response kind. Default 8000 (replyTextSchema's limit). */
  readonly maxReplyChars?: Readonly<Partial<Record<ResponseKind, number>>>;
}

export interface ConnectorCapabilities {
  readonly actions: readonly ModerationAction[];
  readonly listSources: boolean;
  /** Implements listRecentSources (own posts/media, newest first). Used by backfill. */
  readonly recentSources: boolean;
  /** Implements lookupAd (one ad by id: name and deletion). Default false. */
  readonly adLookup?: boolean;
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
  /** Per-platform action limits; see `ActionConstraints`. Default: none. */
  readonly constraints?: ActionConstraints;
  /** Platform permissions each action or response needs. Absent or empty means none are checked. */
  readonly actionScopes?: Readonly<
    Partial<Record<ModerationAction | ResponseKind, readonly string[]>>
  >;
  /** Pattern for account ids from `listAccounts` and in connect requests. Default: Graph ids. */
  readonly accountIdPattern?: RegExp;
  /** Query parameter carrying the authorization code on the callback. Default `code`. */
  readonly oauthCodeParam?: 'code' | 'auth_code';
  /** Implements listConnectionComments (every comment of the connection, not per source). Default false. */
  readonly connectionComments?: boolean;
  /** getComment only searches recent comments, so its null does not mean deleted. Default false. */
  readonly partialCommentLookup?: boolean;
  /** 1..500 */
  readonly maxPageSize: number;
}
