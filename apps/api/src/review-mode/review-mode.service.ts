import { Inject, Injectable } from '@nestjs/common';
import {
  ActionRunner,
  PgActionRunStore,
  PgReviewQueue,
  PgSuggestionStore,
  approveSuggestion,
  bulkDecide,
  dismissSuggestion,
  endReviewModeEarly,
  loadBrandName,
  loadConnectionInfo,
  requestBulkByFilter,
  type DecisionResult,
  type GatedStep,
  type SuggestionServiceDeps,
  type SuggestionStatus,
} from '@feedbouncer/actions';
import { systemClock } from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';
import { recordAudit } from '../audit/audit.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { ApiError, notFound, type ErrorCode } from '../http/errors.js';
import { requireBrand, type BrandScope } from '../tenancy/brand-scope.js';
import { orgCan, type OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import {
  toDecisionDto,
  toHandledDetails,
  toSuggestionDto,
  type DecisionDto,
  type ReviewModeStatusDto,
  type SuggestionDto,
} from './dto.js';

type StepFilter = GatedStep['type'];
type BulkAction = 'approve' | 'dismiss';

export interface SuggestionQuery {
  status?: SuggestionStatus | 'all' | undefined;
  connectionId?: string | undefined;
  ruleId?: string | undefined;
  authorId?: string | undefined;
  stepType?: StepFilter | undefined;
  before?: string | undefined;
  limit: number;
}

export type BulkBody =
  | { action: BulkAction; ids: string[]; requestKey: string; confirm?: true | undefined }
  | {
      action: BulkAction;
      connectionId: string;
      filter: {
        ruleId?: string | undefined;
        authorId?: string | undefined;
        stepType?: StepFilter | undefined;
      };
      requestKey: string;
      confirm?: true | undefined;
    };

const REFUSALS = {
  not_found: [404, 'not_found'],
  confirmation_required: [422, 'confirmation_required'],
  connection_needs_reconnect: [409, 'connection_needs_reconnect'],
  connection_inactive: [409, 'connection_inactive'],
  review_mode_not_active: [409, 'review_mode_not_active'],
  forbidden: [403, 'forbidden'],
} as const satisfies Record<string, readonly [number, ErrorCode]>;

function refusal(code: keyof typeof REFUSALS): ApiError {
  const [status, error] = REFUSALS[code];
  return new ApiError(status, error);
}

/** A decision as a 200 body; every refusal is an error. */
function decided(r: DecisionResult): DecisionDto {
  if (r.status !== 'refused') return r;
  if (r.code === 'already_handled')
    throw new ApiError(409, 'suggestion_already_handled', undefined, {
      handled: toHandledDetails(r.handled),
    });
  throw refusal(r.code);
}

@Injectable()
export class ReviewModeService {
  readonly #suggestions: PgSuggestionStore;
  readonly #runs: PgActionRunStore;
  readonly #service: SuggestionServiceDeps | null;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
  ) {
    this.#suggestions = new PgSuggestionStore(deps.pool);
    this.#runs = new PgActionRunStore(deps.pool);
    this.#service = this.#buildService();
  }

  #buildService(): SuggestionServiceDeps | null {
    const { comments, producer, connectors, pool, log } = this.deps;
    if (!comments || !producer) return null;
    const runner = new ActionRunner({
      pool,
      runs: this.#runs,
      review: new PgReviewQueue(pool),
      comments: comments.store,
      actions: comments.actions,
      connection: (s) =>
        loadConnectionInfo(pool, s, (p) => connectors?.registry.get(p)?.capabilities),
      brandName: (s) => loadBrandName(pool, s),
      producer,
      clock: systemClock,
      log,
    });
    return {
      pool,
      suggestions: this.#suggestions,
      runs: this.#runs,
      runner,
      producer,
      audit: recordAudit,
      clock: systemClock,
      log,
    };
  }

  #configured(): SuggestionServiceDeps {
    if (!this.#service) throw new ApiError(404, 'platform_not_configured');
    return this.#service;
  }

  /** The brand's connection with this id, or 404. */
  async #connection(scope: BrandScope, connectionId: string) {
    const r = await this.deps.pool.query(
      'SELECT 1 FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
      [scope.organizationId, scope.brandId, connectionId],
    );
    if (r.rowCount === 0) throw notFound();
    return { ...scope, connectionId };
  }

  async status(
    org: OrgContext,
    brandId: unknown,
  ): Promise<{ connections: ReviewModeStatusDto[]; pendingTotal: number }> {
    const connections = await this.connections.reviewModes(org, brandId);
    return {
      connections,
      pendingTotal: connections.reduce((n, c) => n + c.pendingCount, 0),
    };
  }

  async end(
    org: OrgContext,
    brandId: unknown,
    connectionId: string,
    body: { pending: 'leave' | 'dismiss' | 'approve'; confirm?: true | undefined },
  ): Promise<{ status: 'ended'; pendingCount: number }> {
    const scope = await this.#connection(
      await requireBrand(this.deps.pool, org, brandId),
      connectionId,
    );
    const r = await endReviewModeEarly(this.#configured(), scope, {
      userId: org.actorUserId,
      mayReply: orgCan(org, 'comment.reply'),
      pending: body.pending,
      ...(body.confirm && { confirm: true }),
    });
    if (r.status === 'refused') throw refusal(r.code);
    return r;
  }

  async list(
    org: OrgContext,
    brandId: unknown,
    q: SuggestionQuery,
  ): Promise<{ items: SuggestionDto[]; next: string | null }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    if (q.connectionId) await this.#connection(scope, q.connectionId);
    const rows = await this.#suggestions.list(
      scope,
      {
        limit: q.limit + 1,
        ...(q.status && { status: q.status }),
        ...(q.connectionId && { connectionId: q.connectionId }),
        ...(q.ruleId && { ruleId: q.ruleId }),
        ...(q.authorId && { authorId: q.authorId }),
        ...(q.stepType && { stepType: q.stepType }),
        ...(q.before && { before: q.before }),
      },
      new Date(systemClock.now()),
    );
    const items = rows.slice(0, q.limit).map(toSuggestionDto);
    return { items, next: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  async authors(
    org: OrgContext,
    brandId: unknown,
    q: { connectionId: string; limit: number },
  ): Promise<{ items: { authorId: string; authorName: string | null; pendingCount: number }[] }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    await this.#connection(scope, q.connectionId);
    return {
      items: await this.#suggestions.pendingAuthors(
        scope,
        q.connectionId,
        q.limit,
        new Date(systemClock.now()),
      ),
    };
  }

  async approve(
    org: OrgContext,
    brandId: unknown,
    id: string,
    body: { requestKey: string; confirm?: true | undefined },
  ): Promise<DecisionDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    return decided(
      await approveSuggestion(this.#configured(), scope, id, {
        userId: org.actorUserId,
        requestKey: body.requestKey,
        mayReply: orgCan(org, 'comment.reply'),
        ...(body.confirm && { confirm: true }),
      }),
    );
  }

  async dismiss(
    org: OrgContext,
    brandId: unknown,
    id: string,
    body: { requestKey: string },
  ): Promise<DecisionDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    return decided(
      await dismissSuggestion(this.#configured(), scope, id, {
        userId: org.actorUserId,
        requestKey: body.requestKey,
      }),
    );
  }

  async bulk(
    org: OrgContext,
    brandId: unknown,
    body: BulkBody,
  ): Promise<
    | { kind: 'ids'; results: { id: string; result: DecisionDto }[] }
    | { kind: 'filter'; matched: number }
  > {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const common = {
      action: body.action,
      userId: org.actorUserId,
      requestKey: body.requestKey,
      mayReply: orgCan(org, 'comment.reply'),
      ...(body.confirm && { confirm: true }),
    };
    if ('ids' in body) {
      const results = await bulkDecide(this.#configured(), scope, { ...common, ids: body.ids });
      return {
        kind: 'ids',
        results: results.map(({ id, result }) => ({ id, result: toDecisionDto(result) })),
      };
    }
    const own = await this.#connection(scope, body.connectionId);
    const filter = {
      ...(body.filter.ruleId && { ruleId: body.filter.ruleId }),
      ...(body.filter.authorId && { authorId: body.filter.authorId }),
      ...(body.filter.stepType && { stepType: body.filter.stepType }),
    };
    const { matched } = await requestBulkByFilter(this.#configured(), own, { ...common, filter });
    return { kind: 'filter', matched };
  }
}
