import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { SafeHttp } from '@feedbouncer/connectors';
import type { Mailer } from '@feedbouncer/mailer';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { ChannelKind, PgAlertChannels } from './channels.js';
import { LEASE_MS, RETRY_AFTER_CAP_MS, RETRY_DELAYS_MS, SLACK_PACE_MS } from './constants.js';
import { classifyEmailFailure } from './email-failure.js';
import { settingsLink } from './links.js';
import {
  renderDisconnectEmail,
  renderEmail,
  renderEmailTest,
  renderSlack,
  renderSlackTest,
  type EmailContent,
} from './render.js';
import { postSlack, type SlackOutcome } from './slack.js';
import { loadAlertView } from './view.js';

export interface DispatcherDeps {
  pool: pg.Pool;
  log: Logger;
  channels: PgAlertChannels;
  web: URL;
  enabled: { slack: boolean; email: boolean };
  mailer: Mailer | null;
  slackHttp: SafeHttp;
  emailPerMinute: number;
  now?: () => Date;
  batch?: number;
}

export interface TickResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

type Failure = Extract<SlackOutcome, { ok: false }>;
type Outcome = { ok: true } | Failure | { ok: false; kind: 'skipped'; code: string };
type Settled = keyof TickResult;

interface Claimed {
  id: string;
  organizationId: string;
  channelId: string;
  eventId: string;
  attempts: number;
  kind: ChannelKind;
  email: string | null;
}

const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export class AlertDispatcher {
  private readonly now: () => Date;
  private readonly batch: number;

  constructor(private readonly d: DispatcherDeps) {
    this.now = d.now ?? (() => new Date());
    this.batch = d.batch ?? 20;
  }

  private get kinds(): ChannelKind[] {
    return [
      ...(this.d.enabled.slack ? (['slack'] as const) : []),
      ...(this.d.enabled.email && this.d.mailer ? (['email'] as const) : []),
    ];
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
    const now = this.now();
    result.failed += await this.reap(now);
    await this.cancelUnavailable();
    const claimed = await this.claim(now);
    const settled = await Promise.allSettled(claimed.map((c) => this.process(c)));
    for (const [i, s] of settled.entries()) {
      if (s.status === 'rejected') {
        this.d.log.error('alerts.dispatch_failed', {
          deliveryId: claimed[i]!.id,
          ...errorFields(s.reason),
        });
      } else if (s.value) result[s.value] += 1;
    }
    return result;
  }

  async sendTest(
    orgId: string,
    channelId: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const r = await this.d.pool.query<{
      kind: ChannelKind;
      status: string;
      email: string | null;
      workspace: string;
    }>(
      `SELECT ch.kind, ch.status, ch.email, o.name AS workspace
         FROM alert_channel ch JOIN organization o ON o.id = ch.organization_id
        WHERE ch.organization_id = $1 AND ch.id = $2`,
      [orgId, channelId],
    );
    const ch = r.rows[0];
    if (!ch) return { ok: false, code: 'not_found' };
    if (!this.kinds.includes(ch.kind)) return { ok: false, code: 'unavailable' };
    if (ch.status !== 'active') {
      return { ok: false, code: ch.kind === 'email' ? 'not_confirmed' : 'not_active' };
    }
    const outcome =
      ch.kind === 'slack'
        ? await this.sendSlack(orgId, channelId, () => renderSlackTest())
        : await this.sendEmail(
            orgId,
            channelId,
            (unsubscribeToken) =>
              renderEmailTest({
                email: ch.email!,
                workspaceName: ch.workspace,
                unsubscribeToken,
                web: this.d.web,
                orgId,
              }),
            ch.email!,
          );
    if (outcome.ok) return { ok: true };
    if (outcome.kind === 'revoked') {
      const disconnected = await withTransaction(this.d.pool, (c) =>
        this.disconnect(c, orgId, channelId, outcome.code),
      );
      if (disconnected) await this.notifyDisconnected(orgId, channelId, outcome.code);
    }
    return { ok: false, code: outcome.code };
  }

  private async reap(now: Date): Promise<number> {
    const r = await this.d.pool.query(
      `WITH reaped AS (
         UPDATE alert_delivery SET state = 'failed', last_error_code = 'outcome_unknown'
          WHERE state = 'sending' AND lease_until < $1
          RETURNING organization_id, channel_id
       ), per_channel AS (
         SELECT organization_id, channel_id, count(*)::int AS n FROM reaped GROUP BY 1, 2
       )
       UPDATE alert_channel ch
          SET consecutive_failures = ch.consecutive_failures + p.n,
              last_failure_at = $1, last_failure_code = 'outcome_unknown'
         FROM per_channel p
        WHERE ch.organization_id = p.organization_id AND ch.id = p.channel_id
       RETURNING p.n`,
      [now],
    );
    return r.rows.reduce((sum, x: { n: number }) => sum + x.n, 0);
  }

  private async cancelUnavailable(): Promise<void> {
    await this.d.pool.query(
      `UPDATE alert_delivery d SET state = 'cancelled'
         FROM alert_channel ch
        WHERE ch.organization_id = d.organization_id AND ch.id = d.channel_id
          AND d.state IN ('pending', 'retrying')
          AND (ch.status <> 'active' OR NOT (ch.kind = ANY($1::text[])))`,
      [this.kinds],
    );
  }

  private claim(now: Date): Promise<Claimed[]> {
    return withTransaction(this.d.pool, async (c) => {
      const locked = await c.query<{ id: string }>(
        `SELECT ch.id FROM alert_channel ch
          WHERE ch.status = 'active' AND ch.kind = ANY($2::text[]) AND ch.next_send_at <= $1
            AND EXISTS (SELECT 1 FROM alert_delivery d
                         WHERE d.organization_id = ch.organization_id AND d.channel_id = ch.id
                           AND d.state IN ('pending', 'retrying') AND d.next_attempt_at <= $1)
          ORDER BY ch.next_send_at, ch.id LIMIT $3
            FOR UPDATE OF ch SKIP LOCKED`,
        [now, this.kinds, this.batch],
      );
      if (locked.rows.length === 0) return [];
      const due = await c.query<{ id: string; kind: ChannelKind }>(
        `SELECT d.id, ch.kind FROM alert_delivery d
           JOIN alert_channel ch ON ch.organization_id = d.organization_id AND ch.id = d.channel_id
          WHERE d.id IN (
                  SELECT DISTINCT ON (channel_id) id FROM alert_delivery
                   WHERE channel_id = ANY($2::uuid[]) AND state IN ('pending', 'retrying') AND next_attempt_at <= $1
                   ORDER BY channel_id, next_attempt_at, id)
          ORDER BY d.next_attempt_at, d.id
            FOR UPDATE OF d SKIP LOCKED`,
        [now, locked.rows.map((x) => x.id)],
      );
      const budget = due.rows.some((x) => x.kind === 'email') ? await this.emailBudget(c, now) : 0;
      let emails = 0;
      const ids = due.rows.filter((x) => x.kind === 'slack' || emails++ < budget).map((x) => x.id);
      if (ids.length === 0) return [];
      const r = await c.query(
        `WITH claimed AS (
           UPDATE alert_delivery SET state = 'sending', attempts = attempts + 1, lease_until = $2
            WHERE id = ANY($1::uuid[]) AND state IN ('pending', 'retrying')
            RETURNING id, organization_id, channel_id, alert_event_id, attempts
         ), paced AS (
           UPDATE alert_channel ch SET next_send_at = $3
             FROM claimed WHERE ch.organization_id = claimed.organization_id AND ch.id = claimed.channel_id
              AND ch.kind = 'slack'
         )
         SELECT claimed.*, ch.kind, ch.email
           FROM claimed JOIN alert_channel ch
             ON ch.organization_id = claimed.organization_id AND ch.id = claimed.channel_id`,
        [ids, new Date(now.getTime() + LEASE_MS), new Date(now.getTime() + SLACK_PACE_MS)],
      );
      return r.rows.map((x) => ({
        id: x.id,
        organizationId: x.organization_id,
        channelId: x.channel_id,
        eventId: x.alert_event_id,
        attempts: x.attempts,
        kind: x.kind,
        email: x.email,
      }));
    });
  }

  /**
   * Sends left this minute across every dispatcher. The advisory lock is held until the claiming
   * transaction commits, so a concurrent dispatcher counts these claims before taking its own.
   */
  private async emailBudget(c: pg.ClientBase, now: Date): Promise<number> {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('alert-email-budget', 0))");
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alert_delivery d
         JOIN alert_channel ch ON ch.organization_id = d.organization_id AND ch.id = d.channel_id
        WHERE ch.kind = 'email' AND (d.state = 'sending' OR d.sent_at > $1)`,
      [new Date(now.getTime() - 60_000)],
    );
    return Math.max(this.d.emailPerMinute - r.rows[0]!.n, 0);
  }

  private async process(d: Claimed): Promise<Settled | null> {
    let outcome: Outcome;
    try {
      outcome = await this.send(d);
    } catch (err) {
      // Name, message and code only: never the payload, URL, webhook or address.
      this.d.log.error('alerts.dispatch_error', {
        deliveryId: d.id,
        channelKind: d.kind,
        ...errorFields(err),
      });
      outcome = { ok: false, kind: 'transient', code: 'internal_error' };
    }
    return this.settle(d, outcome);
  }

  private async send(d: Claimed): Promise<Outcome> {
    const view = await loadAlertView(this.d.pool, this.d.web, d.eventId, d.organizationId);
    if (!view) return { ok: false, kind: 'skipped', code: 'brand_archived' };
    if (view.type === 'flagged_digest' && view.liveItemCount === 0) {
      return { ok: false, kind: 'skipped', code: 'all_resolved' };
    }
    if (d.kind === 'slack') {
      return this.sendSlack(d.organizationId, d.channelId, () => renderSlack(view));
    }
    return this.sendEmail(
      d.organizationId,
      d.channelId,
      (unsubscribeToken) =>
        renderEmail(view, { email: d.email!, unsubscribeToken, web: this.d.web }),
      d.email!,
      `<${d.id}@${this.d.web.hostname}>`,
    );
  }

  private async sendSlack(
    orgId: string,
    channelId: string,
    render: () => Parameters<typeof postSlack>[2],
  ): Promise<Outcome> {
    const url = await this.d.channels.openWebhookUrl(orgId, channelId);
    if (!url) return { ok: false, kind: 'invalid', code: 'invalid_url' };
    return postSlack(this.d.slackHttp, url, render(), () => this.now().getTime());
  }

  private async sendEmail(
    orgId: string,
    channelId: string,
    render: (unsubscribeToken: string) => EmailContent,
    to: string,
    messageId?: string,
  ): Promise<Outcome> {
    const token = await this.d.channels.openUnsubscribeToken(orgId, channelId);
    if (!token) return { ok: false, kind: 'invalid', code: 'no_unsubscribe_token' };
    try {
      await this.d.mailer!.send({ ...render(token), to, ...(messageId && { messageId }) });
      return { ok: true };
    } catch (err) {
      return classifyEmailFailure(err);
    }
  }

  private async settle(d: Claimed, outcome: Outcome): Promise<Settled | null> {
    const now = this.now();
    let state: 'sent' | 'retrying' | 'failed' | 'skipped';
    let code: string | null = null;
    let nextAttemptAt: Date | null = null;
    if (outcome.ok) state = 'sent';
    else if (outcome.kind === 'skipped') {
      state = 'skipped';
      code = outcome.code;
    } else if (outcome.kind === 'transient' || outcome.kind === 'rate_limited') {
      code = outcome.code;
      if (d.attempts < MAX_ATTEMPTS) {
        state = 'retrying';
        const afterMs = Math.min(outcome.retryAfterMs ?? 0, RETRY_AFTER_CAP_MS);
        nextAttemptAt = new Date(
          now.getTime() + Math.max(RETRY_DELAYS_MS[d.attempts - 1]!, afterMs),
        );
      } else {
        state = 'failed';
        code = 'retries_exhausted';
      }
    } else {
      state = 'failed';
      code = outcome.code;
    }

    const disconnected = await withTransaction(this.d.pool, async (c) => {
      const r = await c.query(
        `UPDATE alert_delivery
            SET state = $3, last_error_code = $4, lease_until = NULL,
                next_attempt_at = COALESCE($5, next_attempt_at),
                sent_at = CASE WHEN $3 = 'sent' THEN $6::timestamptz END
          WHERE organization_id = $1 AND id = $2 AND state = 'sending'`,
        [d.organizationId, d.id, state, code, nextAttemptAt, now],
      );
      if (r.rowCount === 0) return null;
      if (state === 'sent') {
        await c.query(
          `UPDATE alert_channel SET consecutive_failures = 0, last_success_at = $3
            WHERE organization_id = $1 AND id = $2`,
          [d.organizationId, d.channelId, now],
        );
      } else if (state !== 'skipped') {
        await c.query(
          `UPDATE alert_channel
              SET consecutive_failures = consecutive_failures + 1, last_failure_at = $3, last_failure_code = $4
            WHERE organization_id = $1 AND id = $2`,
          [d.organizationId, d.channelId, now, code],
        );
      }
      const revoked = !outcome.ok && outcome.kind === 'revoked';
      return revoked
        ? this.disconnect(c, d.organizationId, d.channelId, outcome.code, d.id)
        : false;
    });
    if (disconnected === null) return null;

    this.d.log.info('alerts.dispatch', {
      deliveryId: d.id,
      channelKind: d.kind,
      outcome: !outcome.ok && outcome.kind === 'revoked' ? 'revoked' : state,
      code,
      attempt: d.attempts,
    });
    if (disconnected && !outcome.ok) {
      await this.notifyDisconnected(d.organizationId, d.channelId, outcome.code);
    }
    return state === 'sent' ? 'sent' : state === 'retrying' ? 'retried' : state;
  }

  private async disconnect(
    c: pg.ClientBase,
    orgId: string,
    channelId: string,
    code: string,
    exceptDeliveryId?: string,
  ): Promise<boolean> {
    if (!(await this.d.channels.markDisconnected(c, orgId, channelId, code))) return false;
    await c.query(
      `UPDATE alert_delivery SET state = 'cancelled'
        WHERE organization_id = $1 AND channel_id = $2 AND state IN ('pending', 'retrying')
          AND ($3::uuid IS NULL OR id <> $3)`,
      [orgId, channelId, exceptDeliveryId ?? null],
    );
    return true;
  }

  private async notifyDisconnected(orgId: string, channelId: string, code: string): Promise<void> {
    const { mailer } = this.d;
    if (!mailer || !this.d.enabled.email) return;
    try {
      const r = await this.d.pool.query<{ workspace: string; label: string; emails: string[] }>(
        `SELECT o.name AS workspace, ch.label,
                COALESCE((SELECT array_agg(DISTINCT lower(u.email)) FROM membership m
                            JOIN app_user u ON u.id = m.user_id
                           WHERE m.organization_id = o.id AND m.role IN ('owner', 'admin')), '{}') AS emails
           FROM alert_channel ch JOIN organization o ON o.id = ch.organization_id
          WHERE ch.organization_id = $1 AND ch.id = $2`,
        [orgId, channelId],
      );
      const row = r.rows[0];
      if (!row) return;
      const content = renderDisconnectEmail({
        workspaceName: row.workspace,
        label: row.label,
        code,
        link: settingsLink(this.d.web, orgId),
      });
      await Promise.all(
        row.emails.map((to) =>
          mailer.send({ ...content, to }).catch(() => {
            this.d.log.warn('alerts.disconnect_notify_failed', {
              organizationId: orgId,
              channelId,
            });
          }),
        ),
      );
    } catch {
      this.d.log.warn('alerts.disconnect_notify_failed', { organizationId: orgId, channelId });
    }
  }
}
