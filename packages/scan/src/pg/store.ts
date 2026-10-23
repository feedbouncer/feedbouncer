import type { Pool } from 'pg';
import { isUniqueViolation, withTransaction } from '@feedbouncer/db';
import type { ScanFailure, ScanPageOption, ScanResultV1, ScanStatus } from '../contract.js';

export interface Sealed {
  keyId: string;
  blob: Buffer;
}

export interface GrantRow {
  id: string;
  visitorId: string;
  fbUserHash: Buffer;
  token: Sealed;
  scopes: string[];
  pages: ScanPageOption[];
  expiresAt: Date;
}

export interface ScanRow {
  id: string;
  visitorId: string;
  pageExternalId: string;
  pageName: string;
  igUserId: string | null;
  status: ScanStatus;
  failureReason: ScanFailure | null;
  attempt: number;
  result: unknown | null;
  shared: boolean;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface ClaimedScan {
  attempt: number;
  token: Sealed;
  pageExternalId: string;
  pageName: string;
  igUserId: string | null;
}

export interface PurgeCounts {
  scans: number;
  grants: number;
  states: number;
  visitors: number;
}

const ACTIVE_PAGE_INDEX = 'scan_one_active_per_page_idx';
const DAY_MS = 86_400_000;

const SCAN_COLUMNS = `id, visitor_id, page_external_id, page_name, ig_user_id, status, failure_reason,
  attempt, result, share_token_hash IS NOT NULL AS shared, created_at, finished_at`;

interface ScanDbRow {
  id: string;
  visitor_id: string;
  page_external_id: string;
  page_name: string;
  ig_user_id: string | null;
  status: ScanStatus;
  failure_reason: ScanFailure | null;
  attempt: number;
  result: unknown | null;
  shared: boolean;
  created_at: Date;
  finished_at: Date | null;
}

const toScan = (r: ScanDbRow): ScanRow => ({
  id: r.id,
  visitorId: r.visitor_id,
  pageExternalId: r.page_external_id,
  pageName: r.page_name,
  igUserId: r.ig_user_id,
  status: r.status,
  failureReason: r.failure_reason,
  attempt: r.attempt,
  result: r.result,
  shared: r.shared,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export class PgScanStore {
  constructor(private readonly pool: Pool) {}

  async createVisitor(tokenHash: Buffer): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      'INSERT INTO scan_visitor (token_hash) VALUES ($1) RETURNING id',
      [tokenHash],
    );
    return rows[0]!.id;
  }

  async touchVisitor(tokenHash: Buffer, now: Date): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      'UPDATE scan_visitor SET last_seen_at = $2 WHERE token_hash = $1 RETURNING id',
      [tokenHash, now],
    );
    return rows[0]?.id ?? null;
  }

  async insertOAuthState(i: {
    stateHash: Buffer;
    visitorId: string;
    verifier: Sealed;
    expiresAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO scan_oauth_state (state_hash, visitor_id, key_id, encrypted_pkce_verifier, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [i.stateHash, i.visitorId, i.verifier.keyId, i.verifier.blob, i.expiresAt],
    );
  }

  async consumeOAuthState(stateHash: Buffer, visitorId: string, now: Date): Promise<Sealed | null> {
    const { rows } = await this.pool.query<{ key_id: string; encrypted_pkce_verifier: Buffer }>(
      `DELETE FROM scan_oauth_state
        WHERE state_hash = $1 AND visitor_id = $2 AND expires_at > $3
        RETURNING key_id, encrypted_pkce_verifier`,
      [stateHash, visitorId, now],
    );
    const r = rows[0];
    return r ? { keyId: r.key_id, blob: r.encrypted_pkce_verifier } : null;
  }

  async insertGrant(i: {
    id: string;
    visitorId: string;
    fbUserHash: Buffer;
    token: Sealed;
    scopes: string[];
    pages: ScanPageOption[];
    expiresAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO scan_grant
         (id, visitor_id, fb_user_hash, key_id, encrypted_user_token, granted_scopes, pages, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        i.id,
        i.visitorId,
        i.fbUserHash,
        i.token.keyId,
        i.token.blob,
        i.scopes,
        JSON.stringify(i.pages),
        i.expiresAt,
      ],
    );
  }

  async grantForVisitor(id: string, visitorId: string, now: Date): Promise<GrantRow | null> {
    const { rows } = await this.pool.query<{
      id: string;
      visitor_id: string;
      fb_user_hash: Buffer;
      key_id: string;
      encrypted_user_token: Buffer;
      granted_scopes: string[];
      pages: ScanPageOption[];
      expires_at: Date;
    }>(
      `SELECT id, visitor_id, fb_user_hash, key_id, encrypted_user_token, granted_scopes, pages, expires_at
         FROM scan_grant
        WHERE id = $1 AND visitor_id = $2 AND expires_at > $3`,
      [id, visitorId, now],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          visitorId: r.visitor_id,
          fbUserHash: r.fb_user_hash,
          token: { keyId: r.key_id, blob: r.encrypted_user_token },
          scopes: r.granted_scopes,
          pages: r.pages,
          expiresAt: r.expires_at,
        }
      : null;
  }

  async deleteGrant(id: string, visitorId: string): Promise<void> {
    await this.pool.query('DELETE FROM scan_grant WHERE id = $1 AND visitor_id = $2', [
      id,
      visitorId,
    ]);
  }

  /** Deletes the grant (and its sealed token) and queues the scan in one transaction; a busy page leaves the grant intact. */
  async createScanFromGrant(i: {
    scanId: string;
    grantId: string;
    visitorId: string;
    page: ScanPageOption;
    token: Sealed;
    now: Date;
  }): Promise<'created' | 'grant_gone' | 'page_busy'> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const spent = await client.query(
          `DELETE FROM scan_grant
            WHERE id = $1 AND visitor_id = $2 AND expires_at > $3`,
          [i.grantId, i.visitorId, i.now],
        );
        if (spent.rowCount === 0) return 'grant_gone' as const;
        await client.query(
          `INSERT INTO scan
             (id, visitor_id, page_external_id, page_name, ig_user_id, key_id, encrypted_user_token)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            i.scanId,
            i.visitorId,
            i.page.pageId,
            i.page.name,
            i.page.igUserId,
            i.token.keyId,
            i.token.blob,
          ],
        );
        return 'created' as const;
      });
    } catch (err) {
      if (isUniqueViolation(err, ACTIVE_PAGE_INDEX)) return 'page_busy';
      throw err;
    }
  }

  /** The returned visitorId is internal: never expose it to the page's other users. */
  async activeScanForPage(
    pageExternalId: string,
  ): Promise<{ id: string; visitorId: string } | null> {
    const { rows } = await this.pool.query<{ id: string; visitor_id: string }>(
      `SELECT id, visitor_id FROM scan
        WHERE page_external_id = $1 AND status IN ('queued', 'running')`,
      [pageExternalId],
    );
    return rows[0] ? { id: rows[0].id, visitorId: rows[0].visitor_id } : null;
  }

  async scanForVisitor(id: string, visitorId: string): Promise<ScanRow | null> {
    const { rows } = await this.pool.query<ScanDbRow>(
      `SELECT ${SCAN_COLUMNS} FROM scan WHERE id = $1 AND visitor_id = $2`,
      [id, visitorId],
    );
    return rows[0] ? toScan(rows[0]) : null;
  }

  async listForVisitor(visitorId: string, limit: number): Promise<ScanRow[]> {
    const { rows } = await this.pool.query<ScanDbRow>(
      `SELECT ${SCAN_COLUMNS} FROM scan WHERE visitor_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
      [visitorId, limit],
    );
    return rows.map(toScan);
  }

  /** Starts an attempt. A scan already running is re-claimed (a retry), which fences the older attempt out. */
  async claim(id: string, now: Date): Promise<ClaimedScan | null> {
    const { rows } = await this.pool.query<{
      attempt: number;
      key_id: string;
      encrypted_user_token: Buffer;
      page_external_id: string;
      page_name: string;
      ig_user_id: string | null;
    }>(
      `UPDATE scan SET status = 'running', attempt = attempt + 1, started_at = $2
        WHERE id = $1 AND status IN ('queued', 'running')
        RETURNING attempt, key_id, encrypted_user_token, page_external_id, page_name, ig_user_id`,
      [id, now],
    );
    const r = rows[0];
    return r
      ? {
          attempt: r.attempt,
          token: { keyId: r.key_id, blob: r.encrypted_user_token },
          pageExternalId: r.page_external_id,
          pageName: r.page_name,
          igUserId: r.ig_user_id,
        }
      : null;
  }

  async complete(id: string, attempt: number, result: ScanResultV1, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE scan
          SET status = 'completed', result = $3::jsonb, key_id = NULL, encrypted_user_token = NULL,
              finished_at = $4
        WHERE id = $1 AND status = 'running' AND attempt = $2`,
      [id, attempt, JSON.stringify(result), now],
    );
    return r.rowCount === 1;
  }

  /** A null attempt fails the scan whichever attempt is current. */
  async fail(id: string, attempt: number | null, reason: ScanFailure, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE scan
          SET status = 'failed', failure_reason = $3, result = NULL, key_id = NULL,
              encrypted_user_token = NULL, finished_at = $4
        WHERE id = $1 AND status IN ('queued', 'running') AND ($2::int IS NULL OR attempt = $2)`,
      [id, attempt, reason, now],
    );
    return r.rowCount === 1;
  }

  async deleteScan(id: string, visitorId: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM scan WHERE id = $1 AND visitor_id = $2', [
      id,
      visitorId,
    ]);
    return r.rowCount === 1;
  }

  async deleteVisitor(visitorId: string): Promise<void> {
    await this.pool.query('DELETE FROM scan_visitor WHERE id = $1', [visitorId]);
  }

  async setShare(
    id: string,
    visitorId: string,
    tokenHash: Buffer | null,
  ): Promise<'ok' | 'not_found' | 'not_completed'> {
    const updated = await this.pool.query(
      `UPDATE scan SET share_token_hash = $3
        WHERE id = $1 AND visitor_id = $2 AND status = 'completed'`,
      [id, visitorId, tokenHash],
    );
    if (updated.rowCount === 1) return 'ok';
    const exists = await this.pool.query('SELECT 1 FROM scan WHERE id = $1 AND visitor_id = $2', [
      id,
      visitorId,
    ]);
    return exists.rowCount === 1 ? 'not_completed' : 'not_found';
  }

  async sharedByTokenHash(
    hash: Buffer,
  ): Promise<{ pageName: string; finishedAt: Date; result: unknown } | null> {
    const { rows } = await this.pool.query<{
      page_name: string;
      finished_at: Date;
      result: unknown;
    }>(
      `SELECT page_name, finished_at, result FROM scan
        WHERE share_token_hash = $1 AND status = 'completed'`,
      [hash],
    );
    const r = rows[0];
    return r ? { pageName: r.page_name, finishedAt: r.finished_at, result: r.result } : null;
  }

  /** Deletes scans past retention, expired grants and states, and idle visitors left with nothing. */
  async purge(now: Date, retentionDays: number): Promise<PurgeCounts> {
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    return withTransaction(this.pool, async (client) => {
      const scans = await client.query('DELETE FROM scan WHERE created_at < $1', [cutoff]);
      const grants = await client.query('DELETE FROM scan_grant WHERE expires_at < $1', [now]);
      const states = await client.query('DELETE FROM scan_oauth_state WHERE expires_at < $1', [
        now,
      ]);
      const visitors = await client.query(
        `DELETE FROM scan_visitor v
          WHERE v.last_seen_at < $1
            AND NOT EXISTS (SELECT 1 FROM scan s WHERE s.visitor_id = v.id)
            AND NOT EXISTS (SELECT 1 FROM scan_grant g WHERE g.visitor_id = v.id)
            AND NOT EXISTS (SELECT 1 FROM scan_oauth_state o WHERE o.visitor_id = v.id)`,
        [cutoff],
      );
      return {
        scans: scans.rowCount ?? 0,
        grants: grants.rowCount ?? 0,
        states: states.rowCount ?? 0,
        visitors: visitors.rowCount ?? 0,
      };
    });
  }

  async failStale(now: Date, staleMs: number): Promise<number> {
    const r = await this.pool.query(
      `UPDATE scan
          SET status = 'failed', failure_reason = 'timeout', result = NULL, key_id = NULL,
              encrypted_user_token = NULL, finished_at = $1
        WHERE status = 'running' AND started_at < $2`,
      [now, new Date(now.getTime() - staleMs)],
    );
    return r.rowCount ?? 0;
  }

  /** Fails scans whose job never started within `staleMs`, so no sealed token lingers. */
  async failStaleQueued(now: Date, staleMs: number): Promise<number> {
    const r = await this.pool.query(
      `UPDATE scan
          SET status = 'failed', failure_reason = 'timeout', result = NULL, key_id = NULL,
              encrypted_user_token = NULL, finished_at = $1
        WHERE status = 'queued' AND created_at < $2`,
      [now, new Date(now.getTime() - staleMs)],
    );
    return r.rowCount ?? 0;
  }

  async queuedOlderThan(now: Date, ms: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      "SELECT id FROM scan WHERE status = 'queued' AND created_at < $1 ORDER BY created_at",
      [new Date(now.getTime() - ms)],
    );
    return rows.map((r) => r.id);
  }
}
