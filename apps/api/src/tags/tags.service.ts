import { Inject, Injectable } from '@nestjs/common';
import { PgTriage } from '@feedbouncer/actions';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { toTagDto, type TagDto } from '../org-comments/dto.js';
import { orgCan, type OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';

/** Workspace tags. Tag names are workspace labels shown to members: never log them. */
@Injectable()
export class TagsService {
  readonly #triage: PgTriage;

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#triage = new PgTriage(deps.pool, { log: deps.log });
  }

  async list(org: OrgContext): Promise<{ tags: TagDto[]; canManage: boolean }> {
    const tags = (await this.#triage.listTags(org.organizationId)).map(toTagDto);
    return { tags, canManage: orgCan(org, 'tag.manage') };
  }

  async create(org: OrgContext, name: string): Promise<TagDto> {
    const r = await this.#triage.createTag(org.organizationId, org.actorUserId, name);
    this.deps.log.info('tags.create', { status: r.status });
    switch (r.status) {
      case 'created':
        return toTagDto(r.tag);
      case 'invalid':
        throw new ApiError(400, 'invalid_tag_name', undefined, { reason: r.error });
      case 'taken':
        throw new ApiError(409, 'tag_name_taken', undefined, { tag: toTagDto(r.tag) });
      case 'limit':
        throw new ApiError(409, 'tag_limit_reached');
    }
  }

  async remove(
    org: OrgContext,
    tagId: string,
    confirmCount: number,
  ): Promise<{ removedFrom: number }> {
    const r = await this.#triage.deleteTag(
      org.organizationId,
      org.actorUserId,
      tagId,
      confirmCount,
    );
    this.deps.log.info('tags.delete', { status: r.status });
    if (r.status === 'not_found') throw notFound();
    if (r.status === 'count_changed')
      throw new ApiError(409, 'tag_count_changed', undefined, { count: r.count });
    return { removedFrom: r.removedFrom };
  }
}
