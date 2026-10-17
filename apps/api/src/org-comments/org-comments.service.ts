import { Inject, Injectable } from '@nestjs/common';
import { can } from '@feedbouncer/authz';
import {
  PgVisibleComments,
  type CommentStatus,
  type VisibleCommentFilter,
} from '@feedbouncer/actions';
import type { Platform } from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import {
  toAccountDto,
  toCommentDto,
  toNextDto,
  type CommentFiltersDto,
  type CommentsPageDto,
} from './dto.js';

export interface ListQuery {
  platform?: string | undefined;
  ad?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  before?: string | undefined;
  beforeId?: string | undefined;
  limit: number;
}

@Injectable()
export class OrgCommentsService {
  readonly #read: PgVisibleComments;

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#read = new PgVisibleComments(deps.pool);
  }

  async list(org: OrgContext, q: ListQuery): Promise<CommentsPageDto> {
    const orgId = org.organizationId;
    const asked: VisibleCommentFilter = {
      platform: (q.platform as Platform | undefined) ?? null,
      adId: q.ad ?? null,
      category: q.category ?? null,
      status: (q.status as CommentStatus | undefined) ?? null,
    };
    const f = await this.#read.applicable(orgId, asked, await this.#read.options(orgId));
    const before = q.before && q.beforeId ? { postedAt: new Date(q.before), id: q.beforeId } : null;
    const page = await this.#read.list(orgId, f, { before, limit: q.limit });
    // Counts and filter presence only: never bodies, names or filter values.
    this.deps.log.info('org_comments.list', {
      total: page.total,
      platform: f.platform !== null,
      ad: f.adId !== null,
      category: f.category !== null,
      status: f.status !== null,
    });
    return {
      items: page.items.map(toCommentDto),
      next: toNextDto(page.next),
      total: page.total,
      applied: { platform: f.platform, ad: f.adId, category: f.category, status: f.status },
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
      canManageConnections: can(org.role, 'connection.manage'),
    };
  }
}
