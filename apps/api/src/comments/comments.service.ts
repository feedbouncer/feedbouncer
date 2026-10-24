import { Inject, Injectable } from '@nestjs/common';
import {
  ACTION_KINDS,
  REPLY_KINDS,
  availabilityFor,
  connectionRefusal,
  eligibilityComment,
  resolveConstraints,
  type ActionAvailability,
  type ActionKind,
  type CommentRow,
  type ModerationActionView,
} from '@feedbouncer/comments';
import type { ClassificationView } from '@feedbouncer/classifier';
import { PgPolicyEvaluationStore, type EvaluationView } from '@feedbouncer/policies';
import { systemClock, type ConnectorCapabilities } from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { ClassifierService } from '../classifier/classifier.service.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import { orgCan, type OrgContext } from '../tenancy/org-access.guard.js';
import {
  listCommentDecisions,
  latestDecisions,
  type DecisionDto,
} from '../rules/decisions.queries.js';
import { COMMENTS, DEPS } from '../tokens.js';
import { throwRefusal } from './refusals.js';

export interface CommentView {
  id: string;
  connectionId: string;
  platform: string;
  parentCommentId: string | null;
  /** The parent comment was erased or purged. */
  parentRemoved: boolean;
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
  /** Link to that post, video or ad, when its connector gave one. */
  sourcePermalink: string | null;
  /** What a person may do with this comment now, computed here with the same rules POST actions applies. */
  availability: Record<ActionKind, ActionAvailability>;
  /** Where the comment was found: on an ad post or an organic post. */
  origin: 'ad' | 'organic';
  /** Up to five ads whose post this comment is on. */
  ads: { adId: string; adAccountId: string }[];
  /** Longest reply text per kind, in code points. */
  replyLimits: { public_reply: number; private_reply: number };
  /** The newest decision on this comment (a rule's, today), or null. */
  latestDecision: DecisionDto | null;
}

export interface ListCommentsQuery {
  before?: Date;
  /** Tie-breaker for comments posted at the same instant as `before`. */
  beforeId?: string;
  connectionId?: string;
  origin?: 'ad' | 'organic';
  limit: number;
}

// Sorts before every comment id, so `before` alone means "posted strictly earlier".
const MIN_UUID = '00000000-0000-0000-0000-000000000000';

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
  mayReply: boolean,
): Record<ActionKind, ActionAvailability> {
  const blocked = connectionRefusal(c.connectionStatus);
  if (blocked) return unavailable(blocked);
  if (!caps) return unavailable('unsupported');
  const all = availabilityFor({ comment: eligibilityComment(c), caps, now });
  if (mayReply) return all;
  const notPermitted: ActionAvailability = { available: false, reason: 'not_permitted' };
  return { ...all, public_reply: notPermitted, private_reply: notPermitted };
}

const toView = (
  c: CommentRow,
  caps: ConnectorCapabilities | undefined,
  now: Date,
  latestDecision: DecisionDto | null,
  mayReply: boolean,
): CommentView => ({
  id: c.id,
  connectionId: c.connectionId,
  platform: c.platform,
  parentCommentId: c.parentCommentId,
  parentRemoved: c.parentRemoved,
  authorName: c.authorName,
  hasAuthor: c.authorExternalId !== null,
  body: c.body,
  state: c.platformState,
  postedAt: c.postedAt.toISOString(),
  permalink: c.permalink,
  isOwnAccount: c.isOwnAccount,
  mediaExternalId: c.sourceExternalId,
  sourcePermalink: c.sourcePermalink,
  origin: c.origin,
  ads: c.ads.map((a) => ({ adId: a.adId, adAccountId: a.adAccountId })),
  availability: availability(c, caps, now, mayReply),
  replyLimits: caps ? { ...resolveConstraints(caps).maxReplyChars } : { ...DEFAULT_REPLY_LIMITS },
  latestDecision,
});

@Injectable()
export class CommentsService {
  readonly #policyEvaluations: PgPolicyEvaluationStore;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(COMMENTS) private readonly comments: AppDeps['comments'],
    @Inject(ClassifierService) private readonly classifier: ClassifierService,
  ) {
    this.#policyEvaluations = new PgPolicyEvaluationStore(deps.pool);
  }

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
      ...(q.origin !== undefined && { origin: q.origin }),
    });
    const registry = this.deps.connectors?.registry;
    const now = new Date(systemClock.now());
    const decisions = await latestDecisions(
      this.deps.pool,
      scope,
      rows.map((c) => c.id),
    );
    const mayReply = orgCan(org, 'comment.reply');
    return rows.map((c) =>
      toView(
        c,
        registry?.get(c.platform)?.capabilities,
        now,
        decisions.get(c.id) ?? null,
        mayReply,
      ),
    );
  }

  async decisions(org: OrgContext, brandId: unknown, commentId: string): Promise<DecisionDto[]> {
    const { store } = this.#configured();
    const scope = await requireBrand(this.deps.pool, org, brandId);
    if (!(await store.load(scope, commentId))) throw notFound();
    return listCommentDecisions(this.deps.pool, scope, commentId);
  }

  async classification(
    org: OrgContext,
    brandId: unknown,
    commentId: string,
  ): Promise<ClassificationView | null> {
    const { store } = this.#configured();
    const scope = await requireBrand(this.deps.pool, org, brandId);
    if (!(await store.load(scope, commentId))) throw notFound();
    return this.classifier.latestForComment(scope, commentId);
  }

  async policyEvaluation(
    org: OrgContext,
    brandId: unknown,
    commentId: string,
  ): Promise<{ evaluation: EvaluationView | null }> {
    const { store } = this.#configured();
    const scope = await requireBrand(this.deps.pool, org, brandId);
    if (!(await store.load(scope, commentId))) throw notFound();
    return { evaluation: await this.#policyEvaluations.latestForComment(scope, commentId) };
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
    if (REPLY_KINDS.has(body.kind) && !orgCan(org, 'comment.reply'))
      throw new ApiError(403, 'forbidden');
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
      if (r.code === 'text_too_long')
        throw new ApiError(422, 'text_too_long', undefined, { max: r.max });
      throwRefusal(r.code);
    }
    return { status: r.status === 'accepted' ? 202 : 200, action: r.action };
  }
}
