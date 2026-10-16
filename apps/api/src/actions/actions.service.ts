import { Inject, Injectable } from '@nestjs/common';
import {
  PgActionRunStore,
  PgReviewQueue,
  STEP_META,
  STEP_TYPES,
  StepPlanner,
  loadBrandName,
  loadConnectionInfo,
  loadBrandConnections,
  resolveReviewItem,
  stepSupport,
  undoStep,
  type Resolution,
  type SimulatedStep,
  type StepStatus,
  type StepType,
} from '@feedbouncer/actions';
import { systemClock, type Platform } from '@feedbouncer/connectors';
import { PgRuleStore } from '@feedbouncer/rules';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound, type ErrorCode } from '../http/errors.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import {
  toLogEntryDto,
  toReviewItemDto,
  type CapabilitiesDto,
  type LogEntryDto,
  type ReviewItemDto,
} from './dto.js';

const REFUSALS = {
  not_found: [404, 'not_found'],
  already_undone: [409, 'already_undone'],
  undo_not_available: [422, 'undo_not_available'],
  review_item_resolved: [409, 'review_item_resolved'],
  confirmation_required: [422, 'confirmation_required'],
  unsupported: [422, 'unsupported_action'],
  request_key_conflict: [409, 'request_key_conflict'],
  connection_needs_reconnect: [409, 'connection_needs_reconnect'],
  connection_inactive: [409, 'connection_inactive'],
} as const satisfies Record<string, readonly [number, ErrorCode]>;

function refusal(code: keyof typeof REFUSALS): ApiError {
  const [status, error] = REFUSALS[code];
  return new ApiError(status, error);
}

export interface Page<T> {
  items: T[];
  /** The id to pass as `before` for the next page, or null at the end. */
  next: string | null;
}

/** `rows` holds up to one more row than the page; that extra row only says there is a next page. */
const page = <T extends { id: string }>(rows: T[], limit: number): Page<T> => {
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
};

@Injectable()
export class ActionsService {
  readonly #runs: PgActionRunStore;
  readonly #review: PgReviewQueue;
  readonly #rules: PgRuleStore;

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#runs = new PgActionRunStore(deps.pool);
    this.#review = new PgReviewQueue(deps.pool);
    this.#rules = new PgRuleStore(deps.pool);
  }

  #configured() {
    const { comments, producer } = this.deps;
    if (!comments || !producer) throw new ApiError(404, 'platform_not_configured');
    return { ...comments, producer };
  }

  readonly #capabilities = (p: Platform) => this.deps.connectors?.registry.get(p)?.capabilities;

  async capabilities(org: OrgContext, brandId: unknown): Promise<CapabilitiesDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const conns = await loadBrandConnections(this.deps.pool, scope, this.#capabilities);
    const steps = Object.fromEntries(
      STEP_TYPES.map((type) => [
        type,
        {
          meta: STEP_META[type],
          platforms: conns.map((c) => {
            const s = stepSupport(type, c);
            return {
              platform: c.platform,
              connectionId: c.connectionId,
              supported: s.supported,
              missingScopes: s.supported ? s.missingScopes : [],
              maxChars: s.supported ? s.maxChars : null,
            };
          }),
        },
      ]),
    ) as CapabilitiesDto['steps'];
    return { steps };
  }

  /** What the rule's steps would do to the comment now. Reads only: nothing is stored or sent. */
  async simulate(
    org: OrgContext,
    brandId: unknown,
    ruleId: string,
    commentId: string,
  ): Promise<{ steps: SimulatedStep[] }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const { comments } = this.deps;
    if (!comments) throw new ApiError(404, 'platform_not_configured');
    const rule = await this.#rules.get(scope, ruleId);
    const comment = await comments.store.load(scope, commentId);
    if (!rule || !comment) throw notFound();
    const planner = new StepPlanner({
      runs: this.#runs,
      comments: comments.store,
      actions: comments.actions,
      connection: (s) => loadConnectionInfo(this.deps.pool, s, this.#capabilities),
      brandName: (s) => loadBrandName(this.deps.pool, s),
      clock: systemClock,
    });
    const steps = await planner.simulate(
      { ...scope, connectionId: comment.connectionId },
      commentId,
      rule.actions,
    );
    return { steps };
  }

  async log(
    org: OrgContext,
    brandId: unknown,
    q: {
      ruleId?: string | undefined;
      commentId?: string | undefined;
      status?: StepStatus | undefined;
      type?: StepType | undefined;
      before?: string | undefined;
      limit: number;
    },
  ): Promise<Page<LogEntryDto>> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const rows = await this.#runs.listLog(scope, {
      limit: q.limit + 1,
      ...(q.ruleId && { ruleId: q.ruleId }),
      ...(q.commentId && { commentId: q.commentId }),
      ...(q.status && { status: q.status }),
      ...(q.type && { type: q.type }),
      ...(q.before && { before: q.before }),
    });
    return page(rows.map(toLogEntryDto), q.limit);
  }

  async undo(
    org: OrgContext,
    brandId: unknown,
    stepId: string,
  ): Promise<{ status: 'accepted' | 'done'; undoActionId: string | null }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const { actions } = this.#configured();
    const r = await undoStep(
      { pool: this.deps.pool, runs: this.#runs, review: this.#review, actions },
      scope,
      stepId,
      org.actorUserId,
    );
    if (r.status === 'refused') throw refusal(r.code);
    return { status: r.status, undoActionId: r.undoActionId };
  }

  async reviewItems(
    org: OrgContext,
    brandId: unknown,
    q: { status: 'open' | 'resolved'; before?: string | undefined; limit: number },
  ): Promise<Page<ReviewItemDto>> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const rows = await this.#review.list(scope, {
      status: q.status,
      limit: q.limit + 1,
      ...(q.before && { before: q.before }),
    });
    return page(rows.map(toReviewItemDto), q.limit);
  }

  async resolve(
    org: OrgContext,
    brandId: unknown,
    itemId: string,
    body: { resolution: Resolution; requestKey: string; confirm?: true | undefined },
  ): Promise<{ resolution: Resolution; actionId: string | null }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const { store, actions } = this.#configured();
    const r = await resolveReviewItem(
      { pool: this.deps.pool, review: this.#review, comments: store, actions },
      scope,
      itemId,
      {
        resolution: body.resolution,
        userId: org.actorUserId,
        requestKey: body.requestKey,
        ...(body.confirm && { confirm: body.confirm }),
      },
    );
    if (r.status === 'refused') throw refusal(r.code);
    return { resolution: body.resolution, actionId: r.actionId };
  }
}
