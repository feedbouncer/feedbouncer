import { Inject, Injectable } from '@nestjs/common';
import {
  ACTION_KINDS,
  availabilityFor,
  connectionRefusal,
  eligibilityComment,
  resolveConstraints,
  type ActionAvailability,
  type ActionKind,
  type CommentRow,
  type ModerationActionView,
  type RequestActionResult,
} from '@feedbouncer/comments';
import {
  systemClock,
  type ConnectorCapabilities,
  type ResponseKind,
} from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound, type ErrorCode } from '../http/errors.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { COMMENTS, DEPS } from '../tokens.js';

export interface CommentView {
  id: string;
  connectionId: string;
  platform: string;
  parentCommentId: string | null;
  authorName: string | null;
  /** True when the platform gave an author id, so the author can be banned even without a display name. */
  hasAuthor: boolean;
  /** Plain text exactly as posted; the web app renders it as text, never as markup. */
  body: string;
  state: CommentRow['platformState'];
  postedAt: string;
  permalink: string | null;
  isOwnAccount: boolean;
  /** The media or post the comment is on (the platform's id). */
  mediaExternalId: string;
  /** What a person may do with this comment now, computed here with the same rules POST actions applies. */
  availability: Record<ActionKind, ActionAvailability>;
  /** Longest reply text per kind, in code points. */
  replyLimits: { public_reply: number; private_reply: number };
}

export interface ListCommentsQuery {
  before?: Date;
  /** Tie-breaker for comments posted at the same instant as `before`. */
  beforeId?: string;
  connectionId?: string;
  limit: number;
}

// Sorts before every comment id, so `before` alone means "posted strictly earlier".
const MIN_UUID = '00000000-0000-0000-0000-000000000000';

const REFUSALS: Record<
  Exclude<Extract<RequestActionResult, { status: 'refused' }>['code'], 'not_found'>,
  [number, ErrorCode]
> = {
  unsupported: [422, 'unsupported_action'],
  request_key_conflict: [409, 'request_key_conflict'],
  connection_needs_reconnect: [409, 'connection_needs_reconnect'],
  connection_inactive: [409, 'connection_inactive'],
  text_too_long: [422, 'text_too_long'],
};

/** Used when the platform's connector is not registered (e.g. Instagram disabled after connecting). */
const DEFAULT_REPLY_LIMITS = { public_reply: 8000, private_reply: 8000 } as const;

const unavailable = (reason: string) =>
  Object.fromEntries(
    ACTION_KINDS.map((k): [ActionKind, ActionAvailability] => [k, { available: false, reason }]),
  ) as Record<ActionKind, ActionAvailability>;

/** Same order as POST actions: the connection's state first, then the platform, then the comment. */
function availability(
  c: CommentRow,
  caps: ConnectorCapabilities | undefined,
  now: Date,
): Record<ActionKind, ActionAvailability> {
  const blocked = connectionRefusal(c.connectionStatus);
  if (blocked) return unavailable(blocked);
  if (!caps) return unavailable('platform_not_configured');
  return { ...availabilityFor({ comment: eligibilityComment(c), caps, now }) };
}

const toView = (
  c: CommentRow,
  caps: ConnectorCapabilities | undefined,
  now: Date,
): CommentView => ({
  id: c.id,
  connectionId: c.connectionId,
  platform: c.platform,
  parentCommentId: c.parentCommentId,
  authorName: c.authorName,
  hasAuthor: c.authorExternalId !== null,
  body: c.body,
  state: c.platformState,
  postedAt: c.postedAt.toISOString(),
  permalink: c.permalink,
  isOwnAccount: c.isOwnAccount,
  mediaExternalId: c.sourceExternalId,
  availability: availability(c, caps, now),
  replyLimits: caps
    ? {
        public_reply: resolveConstraints(caps).maxReplyChars.public_reply,
        private_reply: resolveConstraints(caps).maxReplyChars.private_reply,
      }
    : { ...DEFAULT_REPLY_LIMITS },
});

@Injectable()
export class CommentsService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(COMMENTS) private readonly comments: AppDeps['comments'],
  ) {}

  #configured(): NonNullable<AppDeps['comments']> {
    if (!this.comments) throw new ApiError(404, 'platform_not_configured');
    return this.comments;
  }

  async list(org: OrgContext, brandId: unknown, q: ListCommentsQuery): Promise<CommentView[]> {
    const { store } = this.#configured();
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const rows = await store.list(scope, {
      before: q.before ? { postedAt: q.before, id: q.beforeId ?? MIN_UUID } : null,
      limit: q.limit,
      // Deleted comments (including tombstones of never-seen ones) are not listed;
      // filtered in SQL so a page is never short while older comments remain.
      excludeDeleted: true,
      ...(q.connectionId !== undefined && { connectionId: q.connectionId }),
    });
    const registry = this.deps.connectors?.registry;
    const now = new Date(systemClock.now());
    return rows.map((c) => toView(c, registry?.get(c.platform)?.capabilities, now));
  }

  async actions(
    org: OrgContext,
    brandId: unknown,
    commentId: string,
  ): Promise<ModerationActionView[]> {
    const { store, actions } = this.#configured();
    const scope = await requireBrand(this.deps.pool, org, brandId);
    if (!(await store.load(scope, commentId))) throw notFound();
    return actions.list(scope, commentId);
  }

  /** Returns the HTTP status (202 accepted, 200 recorded) with the action. */
  async request(
    org: OrgContext,
    brandId: unknown,
    commentId: string,
    body: { kind: ActionKind; requestKey: string; text?: string | undefined },
  ): Promise<{ status: 200 | 202; action: ModerationActionView }> {
    const { actions } = this.#configured();
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const r = await actions.request({
      scope,
      commentId,
      kind: body.kind,
      actor: { type: 'user', userId: org.actorUserId },
      requestKey: body.requestKey,
      ...(body.text !== undefined && { text: body.text }),
    });
    if (r.status === 'refused') {
      if (r.code === 'not_found') throw notFound();
      const [status, code] = REFUSALS[r.code];
      if (r.code === 'text_too_long')
        throw new ApiError(status, code, undefined, await this.#max(scope, commentId, body.kind));
      throw new ApiError(status, code);
    }
    return { status: r.status === 'accepted' ? 202 : 200, action: r.action };
  }

  /** The limit the refused reply exceeded, for the 422 body. */
  async #max(
    scope: Awaited<ReturnType<typeof requireBrand>>,
    commentId: string,
    kind: ActionKind,
  ): Promise<{ max: number }> {
    const comment = await this.#configured().store.load(scope, commentId);
    const caps = comment && this.deps.connectors?.registry.get(comment.platform)?.capabilities;
    const limits = caps ? resolveConstraints(caps).maxReplyChars : DEFAULT_REPLY_LIMITS;
    return { max: limits[kind as ResponseKind] };
  }
}
