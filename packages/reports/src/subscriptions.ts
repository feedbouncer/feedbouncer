import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { recordAlertAudit } from '@feedbouncer/alerts';
import { withTransaction } from '@feedbouncer/db';
import { open, seal, type KeyProvider } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { REPORT_TOKEN_RE } from './constants.js';

export interface ReportSubscriptionEntry {
  organizationId: string;
  organizationName: string;
  subscribed: boolean;
}

const newToken = () => randomBytes(32).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const context = (organizationId: string, subscriptionId: string) => ({
  organizationId,
  connectionId: subscriptionId,
  kind: 'report_unsubscribe_token' as const,
});

export class PgReportSubscriptions {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: KeyProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Inside the caller's transaction: creates a subscribed row with a sealed token if missing; returns the plaintext token. */
  async ensureToken(c: pg.ClientBase, orgId: string, userId: string): Promise<string> {
    const existing = await this.openToken(c, orgId, userId);
    if (existing !== null) return existing;
    const id = randomUUID();
    const token = newToken();
    const sealed = await seal(this.keys, new Secret(token), context(orgId, id));
    const r = await c.query(
      `INSERT INTO report_subscription
         (id, organization_id, user_id, key_id, unsubscribe_key_sha256, encrypted_unsubscribe_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [id, orgId, userId, sealed.keyId, sha256(token), sealed.blob],
    );
    if (r.rowCount === 1) return token;
    return (await this.openToken(c, orgId, userId))!;
  }

  /** Public one-click path. An invalid shape is rejected without a query. */
  async unsubscribeByToken(
    token: string,
  ): Promise<{ status: 'unsubscribed' | 'already' | 'invalid' }> {
    if (!REPORT_TOKEN_RE.test(token)) return { status: 'invalid' };
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query<{
        id: string;
        organization_id: string;
        user_id: string;
        status: string;
      }>(
        `SELECT id, organization_id, user_id, status FROM report_subscription
          WHERE unsubscribe_key_sha256 = $1 FOR UPDATE`,
        [sha256(token)],
      );
      const row = r.rows[0];
      if (!row) return { status: 'invalid' as const };
      if (row.status === 'unsubscribed') return { status: 'already' as const };
      await this.unsubscribe(tx, row.organization_id, row.user_id, row.id, null);
      return { status: 'unsubscribed' as const };
    });
  }

  /** Orgs where the user is owner or admin; a missing row means subscribed. */
  async listForUser(userId: string): Promise<ReportSubscriptionEntry[]> {
    const r = await this.pool.query<ReportSubscriptionEntry>(
      `SELECT o.id AS "organizationId", o.name AS "organizationName",
              s.status IS DISTINCT FROM 'unsubscribed' AS subscribed
         FROM membership m
         JOIN organization o ON o.id = m.organization_id
         LEFT JOIN report_subscription s ON s.organization_id = m.organization_id AND s.user_id = m.user_id
        WHERE m.user_id = $1 AND m.role IN ('owner', 'admin')
        ORDER BY o.name, o.id`,
      [userId],
    );
    return r.rows;
  }

  /** 'not_found' unless the user is owner or admin of orgId. Resubscribing rotates the token. */
  async setForUser(
    userId: string,
    orgId: string,
    subscribed: boolean,
  ): Promise<{ status: 'ok' | 'not_found' }> {
    return withTransaction(this.pool, async (tx) => {
      const manager = await tx.query(
        `SELECT 1 FROM membership
          WHERE organization_id = $1 AND user_id = $2 AND role IN ('owner', 'admin') FOR SHARE`,
        [orgId, userId],
      );
      if (manager.rowCount === 0) return { status: 'not_found' as const };
      if (!subscribed) await this.ensureToken(tx, orgId, userId);
      const r = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM report_subscription
          WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
        [orgId, userId],
      );
      const row = r.rows[0];
      if (!row || (row.status === 'subscribed') === subscribed) return { status: 'ok' as const };
      if (subscribed) await this.resubscribe(tx, orgId, userId, row.id);
      else await this.unsubscribe(tx, orgId, userId, row.id, userId);
      return { status: 'ok' as const };
    });
  }

  private async openToken(c: pg.ClientBase, orgId: string, userId: string) {
    const r = await c.query<{ id: string; encrypted_unsubscribe_token: Buffer }>(
      `SELECT id, encrypted_unsubscribe_token FROM report_subscription
        WHERE organization_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return (
      await open(this.keys, row.encrypted_unsubscribe_token, context(orgId, row.id))
    ).reveal();
  }

  /** Marks the row unsubscribed and cancels the member's queued deliveries; a null actor is the email link. */
  private async unsubscribe(
    tx: pg.ClientBase,
    orgId: string,
    userId: string,
    subscriptionId: string,
    actorUserId: string | null,
  ) {
    await tx.query(
      `UPDATE report_subscription SET status = 'unsubscribed', unsubscribed_at = $3
        WHERE organization_id = $1 AND id = $2`,
      [orgId, subscriptionId, this.now()],
    );
    await tx.query(
      `UPDATE weekly_report_delivery SET state = 'cancelled', last_error_code = 'unsubscribed'
        WHERE organization_id = $1 AND user_id = $2 AND state IN ('pending', 'retrying')`,
      [orgId, userId],
    );
    await recordAlertAudit(tx, {
      organizationId: orgId,
      actorType: actorUserId === null ? 'system' : 'user',
      actorUserId,
      action: 'report.unsubscribed',
      subjectType: 'report_subscription',
      subjectId: subscriptionId,
    });
  }

  private async resubscribe(tx: pg.ClientBase, orgId: string, userId: string, id: string) {
    const token = newToken();
    const sealed = await seal(this.keys, new Secret(token), context(orgId, id));
    await tx.query(
      `UPDATE report_subscription SET status = 'subscribed', unsubscribed_at = NULL,
              key_id = $3, unsubscribe_key_sha256 = $4, encrypted_unsubscribe_token = $5
        WHERE organization_id = $1 AND id = $2`,
      [orgId, id, sealed.keyId, sha256(token), sealed.blob],
    );
    await recordAlertAudit(tx, {
      organizationId: orgId,
      actorType: 'user',
      actorUserId: userId,
      action: 'report.resubscribed',
      subjectType: 'report_subscription',
      subjectId: id,
    });
  }
}
