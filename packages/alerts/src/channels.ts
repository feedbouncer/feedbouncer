import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction, isUniqueViolation } from '@feedbouncer/db';
import { assertAllowedUrl } from '@feedbouncer/connectors';
import { RECIPIENT } from '@feedbouncer/mailer';
import { open, seal, type KeyProvider } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { recordAlertAudit } from './audit.js';
import { CODE_RE } from './constants.js';

export const SLACK_WEBHOOK_RE =
  /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{2,20}\/B[A-Z0-9]{2,20}\/[A-Za-z0-9]{16,64}$/;

const CONFIRM_TTL_MS = 7 * 86_400_000;
const EMAIL_KEY = 'alert_channel_organization_id_email_key';

export function parseSlackWebhookUrl(
  raw: string,
): { ok: true; url: URL; hint: string } | { ok: false } {
  if (!SLACK_WEBHOOK_RE.test(raw)) return { ok: false };
  try {
    const url = assertAllowedUrl(raw, ['hooks.slack.com']);
    const [, , , , team, hook] = raw.split('/');
    return { ok: true, url, hint: `T…${team!.slice(-4)}/B…${hook!.slice(-4)}` };
  } catch {
    return { ok: false };
  }
}

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && RECIPIENT.test(email) ? email : null;
}

export type ChannelKind = 'slack' | 'email';
export type ChannelStatus = 'pending_confirmation' | 'active' | 'disconnected' | 'unsubscribed';
export type ChannelHealth = ChannelStatus | 'delivery_problem';

export interface AlertChannel {
  id: string;
  kind: ChannelKind;
  label: string;
  status: ChannelStatus;
  health: ChannelHealth;
  hint: string | null;
  email: string | null;
  lastFailureCode: string | null;
  lastFailureAt: Date | null;
  disconnectedCode: string | null;
  createdAt: Date;
}

const COLUMNS = `id, kind, label, status, webhook_hint, email, last_failure_code, last_failure_at,
  last_success_at, disconnected_code, created_at`;

interface ChannelRow {
  id: string;
  kind: ChannelKind;
  label: string;
  status: ChannelStatus;
  webhook_hint: string | null;
  email: string | null;
  last_failure_code: string | null;
  last_failure_at: Date | null;
  last_success_at: Date | null;
  disconnected_code: string | null;
  created_at: Date;
}

function toChannel(r: ChannelRow): AlertChannel {
  const problem =
    r.status === 'active' &&
    r.last_failure_at !== null &&
    (r.last_success_at === null || r.last_failure_at > r.last_success_at);
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    status: r.status,
    health: problem ? 'delivery_problem' : r.status,
    hint: r.webhook_hint,
    email: r.email,
    lastFailureCode: r.last_failure_code,
    lastFailureAt: r.last_failure_at,
    disconnectedCode: r.disconnected_code,
    createdAt: r.created_at,
  };
}

const cleanLabel = (raw: string) => raw.trim().slice(0, 80).trim();

const newToken = () => randomBytes(32).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export class PgAlertChannels {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: KeyProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(orgId: string): Promise<AlertChannel[]> {
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM alert_channel WHERE organization_id = $1 ORDER BY created_at, id`,
      [orgId],
    );
    return r.rows.map(toChannel);
  }

  async get(orgId: string, channelId: string): Promise<AlertChannel | null> {
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM alert_channel WHERE organization_id = $1 AND id = $2`,
      [orgId, channelId],
    );
    return r.rows[0] ? toChannel(r.rows[0]) : null;
  }

  async createSlack(
    orgId: string,
    actorUserId: string,
    i: { label: string; webhookUrl: string },
  ): Promise<
    | { status: 'created'; channel: AlertChannel }
    | { status: 'invalid_webhook_url' | 'invalid_label' }
  > {
    const label = cleanLabel(i.label);
    if (label === '') return { status: 'invalid_label' };
    const parsed = parseSlackWebhookUrl(i.webhookUrl);
    if (!parsed.ok) return { status: 'invalid_webhook_url' };
    const id = randomUUID();
    const sealed = await seal(this.keys, new Secret(parsed.url.href), {
      organizationId: orgId,
      connectionId: id,
      kind: 'alert_slack_webhook',
    });
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query(
        `INSERT INTO alert_channel
           (id, organization_id, kind, label, status, key_id, encrypted_webhook_url, webhook_hint, created_by_user_id)
         VALUES ($1, $2, 'slack', $3, 'active', $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [id, orgId, label, sealed.keyId, sealed.blob, parsed.hint, actorUserId],
      );
      await recordAlertAudit(tx, {
        organizationId: orgId,
        actorType: 'user',
        actorUserId,
        action: 'alert.channel_created',
        subjectType: 'alert_channel',
        subjectId: id,
        details: { kind: 'slack' },
      });
      return { status: 'created' as const, channel: toChannel(r.rows[0]) };
    });
  }

  async reconnectSlack(
    orgId: string,
    actorUserId: string,
    channelId: string,
    webhookUrl: string,
  ): Promise<
    { status: 'ok'; channel: AlertChannel } | { status: 'invalid_webhook_url' | 'not_found' }
  > {
    const parsed = parseSlackWebhookUrl(webhookUrl);
    if (!parsed.ok) return { status: 'invalid_webhook_url' };
    const sealed = await seal(this.keys, new Secret(parsed.url.href), {
      organizationId: orgId,
      connectionId: channelId,
      kind: 'alert_slack_webhook',
    });
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE alert_channel SET status = 'active', key_id = $3, encrypted_webhook_url = $4,
                webhook_hint = $5, disconnected_code = NULL, consecutive_failures = 0,
                last_failure_at = NULL, last_failure_code = NULL, next_send_at = now()
          WHERE organization_id = $1 AND id = $2 AND kind = 'slack' RETURNING ${COLUMNS}`,
        [orgId, channelId, sealed.keyId, sealed.blob, parsed.hint],
      );
      if (!r.rows[0]) return { status: 'not_found' as const };
      await recordAlertAudit(tx, {
        organizationId: orgId,
        actorType: 'user',
        actorUserId,
        action: 'alert.channel_reconnected',
        subjectType: 'alert_channel',
        subjectId: channelId,
        details: { kind: 'slack' },
      });
      return { status: 'ok' as const, channel: toChannel(r.rows[0]) };
    });
  }

  async createEmail(
    orgId: string,
    actorUserId: string,
    i: { email: string; label?: string },
  ): Promise<
    | { status: 'created'; channel: AlertChannel; confirmToken: string }
    | { status: 'invalid_email' | 'email_taken' }
  > {
    const email = normalizeEmail(i.email);
    if (email === null) return { status: 'invalid_email' };
    const label = cleanLabel(i.label ?? '') || cleanLabel(email);
    const id = randomUUID();
    const confirmToken = newToken();
    const unsubscribeToken = newToken();
    const sealed = await this.sealUnsubscribe(orgId, id, unsubscribeToken);
    try {
      return await withTransaction(this.pool, async (tx) => {
        const r = await tx.query(
          `INSERT INTO alert_channel
             (id, organization_id, kind, label, status, key_id, email, confirm_key_sha256, confirm_expires_at,
              unsubscribe_key_sha256, encrypted_unsubscribe_token, created_by_user_id)
           VALUES ($1, $2, 'email', $3, 'pending_confirmation', $4, $5, $6, $7, $8, $9, $10)
           RETURNING ${COLUMNS}`,
          [
            id,
            orgId,
            label,
            sealed.keyId,
            email,
            sha256(confirmToken),
            new Date(this.now().getTime() + CONFIRM_TTL_MS),
            sha256(unsubscribeToken),
            sealed.blob,
            actorUserId,
          ],
        );
        await recordAlertAudit(tx, {
          organizationId: orgId,
          actorType: 'user',
          actorUserId,
          action: 'alert.channel_created',
          subjectType: 'alert_channel',
          subjectId: id,
          details: { kind: 'email' },
        });
        return { status: 'created' as const, channel: toChannel(r.rows[0]), confirmToken };
      });
    } catch (err) {
      if (isUniqueViolation(err, EMAIL_KEY)) return { status: 'email_taken' };
      throw err;
    }
  }

  async rotateConfirmation(
    orgId: string,
    channelId: string,
  ): Promise<{ confirmToken: string; email: string } | null> {
    const confirmToken = newToken();
    const unsubscribeToken = newToken();
    const sealed = await this.sealUnsubscribe(orgId, channelId, unsubscribeToken);
    return withTransaction(this.pool, async (tx) => {
      const cur = await tx.query(
        `SELECT status, email FROM alert_channel
          WHERE organization_id = $1 AND id = $2 AND kind = 'email'
            AND status IN ('pending_confirmation', 'unsubscribed') FOR UPDATE`,
        [orgId, channelId],
      );
      const row = cur.rows[0];
      if (!row) return null;
      const resubscribe = row.status === 'unsubscribed';
      await tx.query(
        `UPDATE alert_channel SET status = 'pending_confirmation', confirm_key_sha256 = $3,
                confirm_expires_at = $4,
                key_id = CASE WHEN $5 THEN $6 ELSE key_id END,
                unsubscribe_key_sha256 = CASE WHEN $5 THEN $7 ELSE unsubscribe_key_sha256 END,
                encrypted_unsubscribe_token = CASE WHEN $5 THEN $8 ELSE encrypted_unsubscribe_token END
          WHERE organization_id = $1 AND id = $2`,
        [
          orgId,
          channelId,
          sha256(confirmToken),
          new Date(this.now().getTime() + CONFIRM_TTL_MS),
          resubscribe,
          sealed.keyId,
          sha256(unsubscribeToken),
          sealed.blob,
        ],
      );
      return { confirmToken, email: row.email as string };
    });
  }

  async confirm(
    token: string,
  ): Promise<{ status: 'confirmed'; organizationId: string } | { status: 'invalid' }> {
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE alert_channel SET status = 'active', confirmed_at = $2,
                confirm_key_sha256 = NULL, confirm_expires_at = NULL
          WHERE confirm_key_sha256 = $1 AND confirm_expires_at > $2 AND status = 'pending_confirmation'
          RETURNING id, organization_id`,
        [sha256(token), this.now()],
      );
      const row = r.rows[0];
      if (!row) return { status: 'invalid' as const };
      await recordAlertAudit(tx, {
        organizationId: row.organization_id,
        actorType: 'system',
        action: 'alert.recipient_confirmed',
        subjectType: 'alert_channel',
        subjectId: row.id,
        details: { kind: 'email' },
      });
      return { status: 'confirmed' as const, organizationId: row.organization_id as string };
    });
  }

  async unsubscribe(
    token: string,
  ): Promise<{ status: 'unsubscribed' | 'already' } | { status: 'invalid' }> {
    return withTransaction(this.pool, async (tx) => {
      const cur = await tx.query(
        `SELECT id, organization_id, status FROM alert_channel
          WHERE unsubscribe_key_sha256 = $1 FOR UPDATE`,
        [sha256(token)],
      );
      const row = cur.rows[0];
      if (!row) return { status: 'invalid' as const };
      if (row.status === 'unsubscribed') return { status: 'already' as const };
      await tx.query(
        `UPDATE alert_channel SET status = 'unsubscribed', confirm_key_sha256 = NULL, confirm_expires_at = NULL
          WHERE organization_id = $1 AND id = $2`,
        [row.organization_id, row.id],
      );
      await tx.query(
        `UPDATE alert_delivery SET state = 'cancelled'
          WHERE organization_id = $1 AND channel_id = $2 AND state IN ('pending', 'retrying')`,
        [row.organization_id, row.id],
      );
      await recordAlertAudit(tx, {
        organizationId: row.organization_id,
        actorType: 'system',
        action: 'alert.recipient_unsubscribed',
        subjectType: 'alert_channel',
        subjectId: row.id,
        details: { kind: 'email' },
      });
      return { status: 'unsubscribed' as const };
    });
  }

  async remove(orgId: string, actorUserId: string, channelId: string): Promise<boolean> {
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query(
        'DELETE FROM alert_channel WHERE organization_id = $1 AND id = $2 RETURNING kind',
        [orgId, channelId],
      );
      if (!r.rows[0]) return false;
      await recordAlertAudit(tx, {
        organizationId: orgId,
        actorType: 'user',
        actorUserId,
        action: 'alert.channel_deleted',
        subjectType: 'alert_channel',
        subjectId: channelId,
        details: { kind: r.rows[0].kind },
      });
      return true;
    });
  }

  async openWebhookUrl(orgId: string, channelId: string): Promise<URL | null> {
    const r = await this.pool.query(
      `SELECT encrypted_webhook_url FROM alert_channel
        WHERE organization_id = $1 AND id = $2 AND kind = 'slack' AND encrypted_webhook_url IS NOT NULL`,
      [orgId, channelId],
    );
    if (!r.rows[0]) return null;
    const secret = await open(this.keys, r.rows[0].encrypted_webhook_url, {
      organizationId: orgId,
      connectionId: channelId,
      kind: 'alert_slack_webhook',
    });
    const parsed = parseSlackWebhookUrl(secret.reveal());
    return parsed.ok ? parsed.url : null;
  }

  async openUnsubscribeToken(orgId: string, channelId: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT encrypted_unsubscribe_token FROM alert_channel
        WHERE organization_id = $1 AND id = $2 AND kind = 'email'`,
      [orgId, channelId],
    );
    if (!r.rows[0]) return null;
    const secret = await open(this.keys, r.rows[0].encrypted_unsubscribe_token, {
      organizationId: orgId,
      connectionId: channelId,
      kind: 'alert_unsubscribe_token',
    });
    return secret.reveal();
  }

  async markDisconnected(
    c: pg.ClientBase,
    orgId: string,
    channelId: string,
    rawCode: string,
  ): Promise<boolean> {
    const code = CODE_RE.test(rawCode) ? rawCode : 'unknown';
    const r = await c.query(
      `UPDATE alert_channel SET status = 'disconnected', disconnected_code = $3
        WHERE organization_id = $1 AND id = $2 AND kind = 'slack' AND status = 'active'`,
      [orgId, channelId, code],
    );
    if (r.rowCount === 0) return false;
    await recordAlertAudit(c, {
      organizationId: orgId,
      actorType: 'system',
      action: 'alert.channel_disconnected',
      subjectType: 'alert_channel',
      subjectId: channelId,
      details: { code },
    });
    return true;
  }

  private sealUnsubscribe(orgId: string, channelId: string, token: string) {
    return seal(this.keys, new Secret(token), {
      organizationId: orgId,
      connectionId: channelId,
      kind: 'alert_unsubscribe_token',
    });
  }
}
