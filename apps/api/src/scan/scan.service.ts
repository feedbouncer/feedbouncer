// A visitor's grants, scans and share links. Every lookup is scoped to the
// visitor, so another visitor's id is the same 404 as an unknown one. Share
// links are 32 random bytes; only their SHA-256 is stored. Stored results are
// re-validated on every read. Tokens and comment text are never logged.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  SCAN_OPTIONAL_SCOPES,
  ScanResultV1,
  redactForShare,
  scanTokenCtx,
  type GrantRow,
  type PgScanStore,
  type ScanPageOption,
  type ScanRow,
  type ScanView,
  type SharedScanView,
} from '@feedbouncer/scan';
import { open, seal } from '@feedbouncer/secrets';
import type { Secret } from '@feedbouncer/service-runtime';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { DEPS, SCAN_LIMITS, SCAN_QUEUE_CLIENT, SCAN_STORE } from '../tokens.js';
import { grantTokenCtx } from './scan-oauth.service.js';
import type { ScanQueueClient } from './scan-queue.client.js';
import type { ScanRateLimits } from './scan-rate-limit.js';

const LIST_LIMIT = 10;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const errorName = (err: unknown) => (err instanceof Error ? err.name : 'NonError');

@Injectable()
export class ScanService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(SCAN_STORE) private readonly store: PgScanStore,
    @Inject(SCAN_LIMITS) private readonly limits: ScanRateLimits,
    @Inject(SCAN_QUEUE_CLIENT) private readonly queue: ScanQueueClient,
  ) {}

  async grant(
    visitorId: string,
    grantId: string,
  ): Promise<{ pages: ScanPageOption[]; instagramGranted: boolean }> {
    const grant = await this.store.grantForVisitor(grantId, visitorId, new Date());
    if (!grant) throw notFound();
    return {
      pages: grant.pages,
      instagramGranted: SCAN_OPTIONAL_SCOPES.every((s) => grant.scopes.includes(s)),
    };
  }

  /** Spends the grant on one scan of one of its eligible Pages and queues it. */
  async create(
    visitorId: string,
    ip: string,
    i: { grantId: string; pageId: string },
  ): Promise<{ scanId: string }> {
    const now = new Date();
    const grant = await this.store.grantForVisitor(i.grantId, visitorId, now);
    if (!grant) throw notFound();
    const page = grant.pages.find((p) => p.pageId === i.pageId);
    if (!page?.eligible) throw new ApiError(422, 'page_not_eligible');
    const spent = await this.limits.createScan({
      ip,
      visitorId,
      fbUserHash: grant.fbUserHash.toString('hex'),
      pageId: page.pageId,
    });

    let scanId: string;
    try {
      scanId = await this.#start(visitorId, grant, page, now);
    } catch (err) {
      // No scan came of it: a busy Page or a spent grant must not burn the day's limits.
      await spent.refund();
      throw err;
    }
    this.deps.metrics.scanCreated.inc();
    this.deps.log.info('scan.created', { visitorId, scanId });
    try {
      await this.queue.enqueue(scanId);
    } catch (err) {
      // The scan stays queued in Postgres; maintenance re-enqueues it.
      this.deps.log.warn('scan.enqueue_failed', { scanId, errorName: errorName(err) });
    }
    return { scanId };
  }

  /** Re-seals the grant's token for a new scan and creates it, spending the grant. */
  async #start(
    visitorId: string,
    grant: GrantRow,
    page: ScanPageOption,
    now: Date,
  ): Promise<string> {
    const keys = this.deps.env.encryption;
    let userToken: Secret;
    try {
      userToken = await open(keys, grant.token.blob, grantTokenCtx(grant.id));
    } catch (err) {
      // An unreadable grant can never be used: drop it, like any spent grant.
      this.deps.log.warn('scan.grant_unreadable', {
        visitorId,
        grantId: grant.id,
        errorName: errorName(err),
      });
      await this.store.deleteGrant(grant.id, visitorId);
      throw notFound();
    }
    const scanId = randomUUID();
    const token = await seal(keys, userToken, scanTokenCtx(scanId));
    const outcome = await this.store.createScanFromGrant({
      scanId,
      grantId: grant.id,
      visitorId,
      page,
      token,
      now,
    });
    if (outcome === 'grant_gone') throw notFound();
    if (outcome === 'page_busy') {
      // Another visitor's scan id is never revealed.
      const active = await this.store.activeScanForPage(page.pageId);
      const own = active?.visitorId === visitorId ? { scanId: active.id } : undefined;
      throw new ApiError(409, 'scan_in_progress', undefined, own);
    }
    return scanId;
  }

  async list(visitorId: string): Promise<{ scans: ScanView[] }> {
    const rows = await this.store.listForVisitor(visitorId, LIST_LIMIT);
    return { scans: rows.map((r) => this.#view(r)) };
  }

  async get(visitorId: string, scanId: string): Promise<ScanView> {
    const row = await this.store.scanForVisitor(scanId, visitorId);
    if (!row) throw notFound();
    return this.#view(row);
  }

  async delete(visitorId: string, scanId: string): Promise<void> {
    if (!(await this.store.deleteScan(scanId, visitorId))) throw notFound();
    this.deps.log.info('scan.deleted', { visitorId, scanId });
  }

  /** A new link for a completed scan; any earlier link stops working. */
  async share(visitorId: string, scanId: string): Promise<{ shareUrl: string }> {
    const token = randomBytes(32).toString('base64url');
    const r = await this.store.setShare(scanId, visitorId, sha256(token));
    if (r === 'not_found') throw notFound();
    if (r === 'not_completed') throw new ApiError(409, 'scan_not_completed');
    this.deps.log.info('scan.shared', { visitorId, scanId });
    return { shareUrl: new URL(`/scan/shared/${token}`, this.deps.env.publicWebUrl).href };
  }

  /** Only a completed scan can have a link, so an unfinished one has nothing to revoke. */
  async unshare(visitorId: string, scanId: string): Promise<void> {
    if ((await this.store.setShare(scanId, visitorId, null)) === 'not_found') throw notFound();
    this.deps.log.info('scan.unshared', { visitorId, scanId });
  }

  async shared(token: string): Promise<SharedScanView> {
    if (!SHARE_TOKEN.test(token)) throw notFound();
    const row = await this.store.sharedByTokenHash(sha256(token));
    if (!row) throw notFound();
    return {
      pageName: row.pageName,
      finishedAt: row.finishedAt.toISOString(),
      result: redactForShare(this.#result(row.result, null)),
    };
  }

  /** Deletes the visitor; the database cascades to its states, grants and scans. */
  async deleteVisitor(visitorId: string): Promise<void> {
    await this.store.deleteVisitor(visitorId);
    this.deps.log.info('scan.visitor_deleted', { visitorId });
  }

  #view(r: ScanRow): ScanView {
    return {
      id: r.id,
      status: r.status,
      failureReason: r.failureReason,
      pageName: r.pageName,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      shared: r.shared,
      result: r.status === 'completed' ? this.#result(r.result, r.id) : null,
    };
  }

  /** A stored result that no longer matches the contract is a 500 that shows none of it. */
  #result(stored: unknown, scanId: string | null): ScanResultV1 {
    const parsed = ScanResultV1.safeParse(stored);
    if (parsed.success) return parsed.data;
    this.deps.log.error('scan.result_invalid', { scanId });
    throw new ApiError(500, 'internal_error');
  }
}
