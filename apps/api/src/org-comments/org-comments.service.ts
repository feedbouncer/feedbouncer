import { Inject, Injectable } from '@nestjs/common';
import {
  PgTriage,
  PgVisibleComments,
  type TriageItemResult,
  type TriageOp,
  type VisibleCommentFilter,
} from '@feedbouncer/actions';
import type { ActionStatus, BrandScope } from '@feedbouncer/comments';
import type { AppDeps } from '../deps.js';
import { throwRefusal } from '../comments/refusals.js';
import { ApiError, notFound } from '../http/errors.js';
import { orgCan, type OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import type { ListQueryDto } from './org-comments.controller.js';
import { replyAvailability } from './reply-availability.js';
import {
  toAccountDto,
  toCommentDto,
  toNextDto,
  type CommentFiltersDto,
  type CommentsPageDto,
  type ReplyDto,
} from './dto.js';

const REPLIES_LIMIT = 50;

interface ReplyRow {
  id: string;
  status: ActionStatus;
  outcome_code: string | null;
  reply_text: string;
  author_name: string | null;
  actor_type: string;
  created_at: Date;
  completed_at: Date | null;
}

const toReplyDto = (r: ReplyRow): ReplyDto => ({
  id: r.id,
  status: r.status,
  outcomeCode: r.outcome_code,
  text: r.reply_text,
  authorName: r.author_name,
  actorType: r.actor_type,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at && r.completed_at.toISOString(),
});

// Public replies of one comment in its brand, newest first; $4 optionally narrows to one action.
// The author is the user's display name, for people only.
const REPLIES_SQL = `
SELECT ma.id, ma.status, ma.outcome_code, ma.reply_text, ma.actor_type, ma.created_at, ma.completed_at,
       CASE WHEN ma.actor_type = 'user' THEN u.display_name END AS author_name
  FROM moderation_action ma
  LEFT JOIN app_user u ON u.id = ma.actor_user_id
 WHERE ma.organization_id = $1 AND ma.brand_id = $2 AND ma.comment_id = $3
   AND ma.kind = 'public_reply' AND ($4::uuid IS NULL OR ma.id = $4::uuid)
 ORDER BY ma.created_at DESC, ma.id DESC
 LIMIT ${REPLIES_LIMIT}`;

@Injectable()
export class OrgCommentsService {
  readonly #read: PgVisibleComments;
  readonly #triage: PgTriage;

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#read = new PgVisibleComments(deps.pool);
    this.#triage = new PgTriage(deps.pool, { log: deps.log });
  }

  async list(org: OrgContext, q: ListQueryDto): Promise<CommentsPageDto> {
    const orgId = org.organizationId;
    const asked: VisibleCommentFilter = {
      platform: q.platform ?? null,
      adId: q.ad ?? null,
      category: q.category ?? null,
      status: q.status ?? null,
      queue: q.queue,
      tagIds: q.tags ?? [],
      brandId: q.brand ?? null,
      postedFrom: q.from ? new Date(q.from) : null,
      postedTo: q.to ? new Date(q.to) : null,
      signal: q.signal ?? null,
    };
    const f = await this.#read.applicable(orgId, asked);
    const before = q.before && q.beforeId ? { postedAt: new Date(q.before), id: q.beforeId } : null;
    const page = await this.#read.list(orgId, f, { before, limit: q.limit });
    // Counts, presence flags and the closed queue name only: never bodies, names or filter values.
    this.deps.log.info('org_comments.list', {
      total: page.total,
      platform: f.platform !== null,
      ad: f.adId !== null,
      category: f.category !== null,
      status: f.status !== null,
      queue: f.queue,
      tags: f.tagIds.length,
      brand: f.brandId !== null,
      range: f.postedFrom !== null || f.postedTo !== null,
      signal: f.signal,
    });
    const registry = this.deps.connectors?.registry;
    const permitted = orgCan(org, 'comment.reply');
    const now = new Date();
    return {
      items: page.items.map((c) =>
        toCommentDto(
          c,
          replyAvailability({
            permitted,
            target: c.replyTarget,
            postedAt: c.postedAt,
            caps: registry?.get(c.platform)?.capabilities,
            now,
          }),
        ),
      ),
      next: toNextDto(page.next),
      total: page.total,
      applied: {
        platform: f.platform,
        ad: f.adId,
        category: f.category,
        status: f.status,
        queue: f.queue,
        tags: f.tagIds,
        brand: f.brandId,
        from: f.postedFrom && f.postedFrom.toISOString(),
        to: f.postedTo && f.postedTo.toISOString(),
        signal: f.signal,
      },
    };
  }

  async filters(org: OrgContext): Promise<CommentFiltersDto> {
    const [options, accounts] = await Promise.all([
      this.#read.options(org.organizationId),
      this.#read.accounts(org.organizationId),
    ]);
    const synced = accounts.flatMap((a) => (a.lastSyncedAt ? [a.lastSyncedAt.getTime()] : []));
    return {
      options,
      accounts: accounts.map(toAccountDto),
      lastSyncedAt: synced.length ? new Date(Math.max(...synced)).toISOString() : null,
      canManageConnections: orgCan(org, 'connection.manage'),
      permissions: {
        reply: orgCan(org, 'comment.reply'),
        triage: orgCan(org, 'comment.triage'),
        manageTags: orgCan(org, 'tag.manage'),
      },
    };
  }

  async #scope(org: OrgContext, commentId: string): Promise<BrandScope> {
    const scope = await this.#triage.commentScope(org.organizationId, commentId);
    if (!scope) throw notFound();
    return scope;
  }

  async #replies(scope: BrandScope, commentId: string, actionId: string | null) {
    const { rows } = await this.deps.pool.query<ReplyRow>(REPLIES_SQL, [
      scope.organizationId,
      scope.brandId,
      commentId,
      actionId,
    ]);
    return rows.map(toReplyDto);
  }

  async replies(org: OrgContext, commentId: string): Promise<ReplyDto[]> {
    return this.#replies(await this.#scope(org, commentId), commentId, null);
  }

  /** 202 when sent for delivery, 200 when the outcome was known up front (e.g. already deleted). */
  async reply(
    org: OrgContext,
    commentId: string,
    body: { requestKey: string; text: string },
  ): Promise<{ status: 200 | 202; reply: ReplyDto }> {
    const actions = this.deps.comments?.actions;
    if (!actions) throw new ApiError(404, 'platform_not_configured');
    const scope = await this.#scope(org, commentId);
    const r = await actions.request({
      scope,
      commentId,
      kind: 'public_reply',
      actor: { type: 'user', userId: org.actorUserId },
      requestKey: body.requestKey,
      text: body.text,
    });
    // Outcome codes only: never the reply text.
    this.deps.log.info('org_comments.reply', {
      status: r.status,
      kind: 'public_reply',
      outcome: r.status === 'refused' ? r.code : r.action.status,
    });
    if (r.status === 'refused') {
      if (r.code === 'not_found') throw notFound();
      if (r.code === 'text_too_long')
        throw new ApiError(422, 'text_too_long', undefined, { max: r.max });
      throwRefusal(r.code);
    }
    const [reply] = await this.#replies(scope, commentId, r.action.id);
    if (!reply) throw notFound();
    return { status: r.status === 'accepted' ? 202 : 200, reply };
  }

  async triage(
    org: OrgContext,
    commentIds: string[],
    op: TriageOp,
  ): Promise<{ results: TriageItemResult[] }> {
    const r = await this.#triage.apply(org.organizationId, org.actorUserId, commentIds, op);
    if (r.status === 'unknown_tags') throw new ApiError(422, 'unknown_tag');
    return { results: r.results };
  }
}
