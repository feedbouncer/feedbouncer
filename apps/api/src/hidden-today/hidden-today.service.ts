import { Inject, Injectable } from '@nestjs/common';
import { can } from '@feedbouncer/authz';
import {
  PgActionRunStore,
  PgHiddenTodayStore,
  PgReviewQueue,
  unhideHidden,
  type HiddenCursor,
} from '@feedbouncer/actions';
import { systemClock } from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';
import { recordAudit } from '../audit/audit.js';
import { ApiError, notFound } from '../http/errors.js';
import { OrgsService } from '../orgs/orgs.service.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import {
  toBrandDayDto,
  toHiddenItemDto,
  toNextDto,
  type HiddenItemDto,
  type HiddenPageDto,
} from './dto.js';

@Injectable()
export class HiddenTodayService {
  readonly #store: PgHiddenTodayStore;
  readonly #runs: PgActionRunStore;
  readonly #review: PgReviewQueue;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(OrgsService) private readonly orgs: OrgsService,
  ) {
    this.#store = new PgHiddenTodayStore(deps.pool);
    this.#runs = new PgActionRunStore(deps.pool);
    this.#review = new PgReviewQueue(deps.pool);
  }

  /** Every organization where the user may moderate, read fresh so a removal applies at once. */
  async list(
    userId: string,
    q: { before: HiddenCursor | null; limit: number },
  ): Promise<HiddenPageDto> {
    const orgIds = (await this.orgs.listMine(userId))
      .filter((m) => can(m.role, 'comment.moderate'))
      .map((m) => m.organization.id);
    if (orgIds.length === 0) return { items: [], next: null, brands: [] };
    const now = new Date(systemClock.now());
    // Without a Meta connector there is nothing to show or unhide, whatever rows remain.
    if (!this.deps.comments) {
      const brands = await this.#store.brandDays(orgIds, now);
      return { items: [], next: null, brands: brands.map(toBrandDayDto) };
    }
    const r = await this.#store.list(orgIds, now, q);
    return {
      items: r.items.map(toHiddenItemDto),
      next: toNextDto(r.next),
      brands: r.brands.map(toBrandDayDto),
    };
  }

  async get(org: OrgContext, brandId: unknown, hideActionId: string): Promise<HiddenItemDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const item = await this.#store.load(scope, hideActionId, new Date(systemClock.now()));
    if (!item) throw notFound();
    return toHiddenItemDto(item);
  }

  async unhide(org: OrgContext, brandId: unknown, hideActionId: string): Promise<HiddenItemDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const { comments, connectors } = this.deps;
    if (!comments) throw new ApiError(404, 'platform_not_configured');
    const r = await unhideHidden(
      {
        pool: this.deps.pool,
        hidden: this.#store,
        runs: this.#runs,
        review: this.#review,
        actions: comments.actions,
        audit: recordAudit,
        caps: (p) => connectors?.registry.get(p)?.capabilities ?? null,
        clock: systemClock,
      },
      scope,
      hideActionId,
      org.actorUserId,
    );
    if (r.status === 'ok') return toHiddenItemDto(r.item);
    if (r.code === 'not_found') throw notFound();
    if (r.code === 'missing_permission')
      throw new ApiError(409, 'missing_permission', undefined, { permission: r.permission });
    throw new ApiError(409, r.code);
  }
}
