import { Inject, Injectable } from '@nestjs/common';
import type {
  ActionKind,
  CommentRow,
  ModerationActionView,
  RequestActionResult,
} from '@feedbouncer/comments';
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
  Extract<RequestActionResult, { status: 'refused' }>['code'],
  [number, ErrorCode]
> = {
  not_found: [404, 'not_found'],
  unsupported: [422, 'unsupported_action'],
  request_key_conflict: [409, 'request_key_conflict'],
  connection_needs_reconnect: [409, 'connection_needs_reconnect'],
  connection_inactive: [409, 'connection_inactive'],
};

const toView = (c: CommentRow): CommentView => ({
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
    return rows.map(toView);
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
      const [status, code] = REFUSALS[r.code];
      throw code === 'not_found' ? notFound() : new ApiError(status, code);
    }
    return { status: r.status === 'accepted' ? 202 : 200, action: r.action };
  }
}
