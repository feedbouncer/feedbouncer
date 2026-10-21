import { createReadStream, type ReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { orgCan, type OrgContext } from '../tenancy/org-access.guard.js';
import { withTransaction } from '@feedbouncer/db';
import {
  readRetentionStatus,
  type PgPrivacyRequestStore,
  type RetentionStatus,
} from '@feedbouncer/privacy';
import { errorFields } from '@feedbouncer/service-runtime';
import { recordAudit } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { DEPS, PRIVACY_QUEUE_CLIENT, PRIVACY_REQUESTS } from '../tokens.js';
import { recordPrivacyDenial } from './denial.js';
import type { PrivacyQueueClient } from './privacy-queue.client.js';
import {
  isDownloadable,
  toPrivacyRequestDto,
  type CreatePrivacyRequestBody,
  type PrivacyRequestDto,
} from './dto.js';

export const CREATE_ROUTE = 'POST /api/v1/orgs/:orgId/privacy/requests';

/**
 * Subject export and erasure requests. The API only records and queues them (the identifiers go
 * straight into the sealed column) and serves finished exports; the worker does the work.
 */
@Injectable()
export class PrivacyService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(PRIVACY_REQUESTS) private readonly store: PgPrivacyRequestStore,
    @Inject(PRIVACY_QUEUE_CLIENT) private readonly queue: PrivacyQueueClient,
  ) {}

  retention(): Promise<RetentionStatus> {
    return readRetentionStatus(this.deps.pool);
  }

  async create(org: OrgContext, body: CreatePrivacyRequestBody): Promise<{ id: string }> {
    // The decorator only asks for privacy.read; the capability that matches the kind is checked here.
    const capability = body.kind === 'export' ? 'privacy.export' : 'privacy.erase';
    if (!orgCan(org, capability)) {
      await recordPrivacyDenial(this.deps, org, capability, CREATE_ROUTE);
      throw new ApiError(403, 'forbidden');
    }
    const { id } = await this.store.create({
      organizationId: org.organizationId,
      kind: body.kind,
      mode: body.dryRun ? 'dry_run' : 'execute',
      subjects: body.subjects,
      via: 'api',
      actorUserId: org.actorUserId,
      actorLabel: null,
      reference: body.reference ?? null,
      keepRuleEntriesReason: body.keepRuleEntries?.reason ?? null,
    });
    this.deps.log.info('privacy.request_created', {
      orgId: org.organizationId,
      requestId: id,
      kind: body.kind,
    });
    try {
      await this.queue.enqueue(id);
    } catch (err) {
      // The request is stored; the worker's sweeper queues it again within minutes.
      this.deps.log.warn('privacy.enqueue_failed', { requestId: id, ...errorFields(err) });
    }
    return { id };
  }

  async list(
    org: OrgContext,
    o: { limit: number; before?: string | undefined },
  ): Promise<{ items: PrivacyRequestDto[] }> {
    const rows = await this.store.list(org.organizationId, {
      limit: o.limit,
      ...(o.before && { before: o.before }),
    });
    const now = new Date();
    return { items: rows.map((r) => toPrivacyRequestDto(r, now)) };
  }

  async get(org: OrgContext, id: string): Promise<PrivacyRequestDto> {
    const r = await this.store.get(org.organizationId, id);
    if (!r) throw notFound();
    return toPrivacyRequestDto(r);
  }

  /**
   * Opens a finished export of this organization. Anything else (unknown, other organization,
   * not an export, not done, expired, missing, outside the export directory) is the same 404.
   */
  async download(org: OrgContext, id: string): Promise<{ stream: ReadStream; bytes: number }> {
    const r = await this.store.get(org.organizationId, id);
    if (!r || !isDownloadable(r, new Date())) throw notFound();
    const file = await this.exportFile(id);
    await withTransaction(this.deps.pool, (tx) =>
      recordAudit(tx, {
        organizationId: org.organizationId,
        actorUserId: org.actorUserId,
        action: 'privacy.export_downloaded',
        subjectType: 'privacy_request',
        subjectId: id,
        details: { requestId: id },
      }),
    );
    return { stream: createReadStream(file.path), bytes: file.bytes };
  }

  /** The export's real path, only when it is a regular file inside the real export directory. */
  private async exportFile(id: string): Promise<{ path: string; bytes: number }> {
    try {
      const dir = await realpath(this.deps.env.privacyExportDir);
      const real = await realpath(path.join(this.deps.env.privacyExportDir, `${id}.zip`));
      const info = await stat(real);
      if (!real.startsWith(dir + path.sep) || !info.isFile()) throw notFound();
      return { path: real, bytes: info.size };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw notFound();
    }
  }
}
