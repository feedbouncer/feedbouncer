// Sends queued weekly-report emails at most once each, retrying transient SMTP failures.
// Logs ids and codes only: never an address, a name or a token.
import type pg from 'pg';
import { classifyEmailFailure, LEASE_MS, RETRY_DELAYS_MS } from '@feedbouncer/alerts';
import { withTransaction } from '@feedbouncer/db';
import type { Mailer, OutboundEmail } from '@feedbouncer/mailer';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import { MAX_ATTEMPTS } from './constants.js';
import { renderWeeklyEmail } from './render.js';
import type { WeeklyStats } from './stats.js';
import type { PgReportSubscriptions } from './subscriptions.js';
import { buildView } from './view.js';

const CLAIM_BATCH = 20;

interface TickResult {
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
  reaped: number;
}

type Outcome =
  | { ok: true }
  | { ok: false; kind: 'invalid' | 'transient' | 'cancelled'; code: string };
type Settled = Exclude<keyof TickResult, 'reaped'>;

interface Claimed {
  id: string;
  organizationId: string;
  reportId: string;
  userId: string;
  attempts: number;
}

interface Recipient {
  workspace: string;
  payload: WeeklyStats;
  week_start: string;
  role: string | null;
  email: string | null;
  email_verified: boolean | null;
  unsubscribed: boolean;
}

const CLAIM_SQL = `
  WITH due AS (
    SELECT id FROM weekly_report_delivery
     WHERE state IN ('pending', 'retrying') AND next_attempt_at <= $1
     ORDER BY next_attempt_at, id
     LIMIT $3
       FOR UPDATE SKIP LOCKED)
  UPDATE weekly_report_delivery d
     SET state = 'sending', attempts = d.attempts + 1, lease_until = $2
    FROM due
   WHERE d.id = due.id
  RETURNING d.id, d.organization_id, d.report_id, d.user_id, d.attempts`;

// The send-time recipient check (verified owners and admins who have not unsubscribed), scoped to the report's organization.
const RECIPIENT_SQL = `
  SELECT o.name AS workspace, r.payload, to_char(r.week_start, 'YYYY-MM-DD') AS week_start,
         m.role, u.email, u.email_verified,
         EXISTS (SELECT 1 FROM report_subscription s
                  WHERE s.organization_id = r.organization_id AND s.user_id = $3
                    AND s.status = 'unsubscribed') AS unsubscribed
    FROM weekly_report r
    JOIN organization o ON o.id = r.organization_id
    LEFT JOIN membership m ON m.organization_id = r.organization_id AND m.user_id = $3
    LEFT JOIN app_user u ON u.id = m.user_id
   WHERE r.organization_id = $1 AND r.id = $2`;

export class WeeklyReportDispatcher {
  private readonly now: () => Date;

  constructor(
    private readonly d: {
      pool: pg.Pool;
      log: Logger;
      mailer: Mailer;
      subscriptions: PgReportSubscriptions;
      web: URL;
      now?: () => Date;
    },
  ) {
    this.now = d.now ?? (() => new Date());
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, retried: 0, failed: 0, cancelled: 0, reaped: 0 };
    const now = this.now();
    result.reaped = await this.reap(now);
    const claimed = await this.claim(now);
    const settled = await Promise.allSettled(claimed.map((c) => this.process(c)));
    for (const [i, s] of settled.entries()) {
      if (s.status === 'rejected') {
        this.d.log.error('reports.dispatch_failed', {
          deliveryId: claimed[i]!.id,
          organizationId: claimed[i]!.organizationId,
          ...errorFields(s.reason),
        });
      } else if (s.value) result[s.value] += 1;
    }
    return result;
  }

  /** A send whose lease expired may have reached the recipient: never resend it. */
  private async reap(now: Date): Promise<number> {
    const r = await this.d.pool.query<{ id: string; organization_id: string }>(
      `UPDATE weekly_report_delivery
          SET state = 'failed', last_error_code = 'outcome_unknown', lease_until = NULL
        WHERE state = 'sending' AND lease_until < $1
        RETURNING id, organization_id`,
      [now],
    );
    for (const x of r.rows) {
      this.d.log.warn('reports.delivery_failed', {
        deliveryId: x.id,
        organizationId: x.organization_id,
        code: 'outcome_unknown',
      });
    }
    return r.rows.length;
  }

  private async claim(now: Date): Promise<Claimed[]> {
    const r = await this.d.pool.query<{
      id: string;
      organization_id: string;
      report_id: string;
      user_id: string;
      attempts: number;
    }>(CLAIM_SQL, [now, new Date(now.getTime() + LEASE_MS), CLAIM_BATCH]);
    return r.rows.map((x) => ({
      id: x.id,
      organizationId: x.organization_id,
      reportId: x.report_id,
      userId: x.user_id,
      attempts: x.attempts,
    }));
  }

  private async process(d: Claimed): Promise<Settled | null> {
    let outcome: Outcome;
    try {
      outcome = await this.send(d);
    } catch (err) {
      this.d.log.error('reports.dispatch_error', {
        deliveryId: d.id,
        organizationId: d.organizationId,
        ...errorFields(err),
      });
      outcome = { ok: false, kind: 'transient', code: 'internal_error' };
    }
    return this.settle(d, outcome);
  }

  private async send(d: Claimed): Promise<Outcome> {
    const message = await withTransaction(
      this.d.pool,
      async (c): Promise<OutboundEmail | Outcome> => {
        const r = await c.query<Recipient>(RECIPIENT_SQL, [d.organizationId, d.reportId, d.userId]);
        const x = r.rows[0];
        if (!x || (x.role !== 'owner' && x.role !== 'admin') || !x.email_verified || !x.email) {
          return { ok: false, kind: 'cancelled', code: 'not_recipient' };
        }
        if (x.unsubscribed) return { ok: false, kind: 'cancelled', code: 'unsubscribed' };
        const token = await this.d.subscriptions.ensureToken(c, d.organizationId, d.userId);
        const content = renderWeeklyEmail(buildView(x.payload, x.workspace), {
          web: this.d.web,
          orgId: d.organizationId,
          weekStart: x.week_start,
          role: x.role,
          token,
          deliveryId: d.id,
        });
        return { ...content, to: x.email };
      },
    );
    if ('ok' in message) return message;
    try {
      await this.d.mailer.send(message);
      return { ok: true };
    } catch (err) {
      return classifyEmailFailure(err);
    }
  }

  private async settle(d: Claimed, outcome: Outcome): Promise<Settled | null> {
    const now = this.now();
    let state: 'sent' | 'retrying' | 'failed' | 'cancelled';
    let code: string | null = null;
    let nextAttemptAt: Date | null = null;
    if (outcome.ok) state = 'sent';
    else if (outcome.kind !== 'transient') {
      state = outcome.kind === 'cancelled' ? 'cancelled' : 'failed';
      code = outcome.code;
    } else if (d.attempts < MAX_ATTEMPTS) {
      state = 'retrying';
      code = outcome.code;
      nextAttemptAt = new Date(now.getTime() + RETRY_DELAYS_MS[d.attempts - 1]!);
    } else {
      state = 'failed';
      code = 'retries_exhausted';
    }

    const r = await this.d.pool.query(
      `UPDATE weekly_report_delivery
          SET state = $3, last_error_code = $4, lease_until = NULL,
              next_attempt_at = COALESCE($5, next_attempt_at),
              sent_at = CASE WHEN $3 = 'sent' THEN $6::timestamptz END
        WHERE organization_id = $1 AND id = $2 AND state = 'sending'`,
      [d.organizationId, d.id, state, code, nextAttemptAt, now],
    );
    // Reaped meanwhile (lease expired mid-send): that outcome stands.
    if (r.rowCount === 0) return null;

    const fields = { deliveryId: d.id, organizationId: d.organizationId };
    if (state === 'failed' || state === 'retrying') {
      this.d.log.warn('reports.delivery_failed', { ...fields, code });
    } else {
      this.d.log.info(`reports.delivery_${state}`, { ...fields, ...(code && { code }) });
    }
    return state === 'retrying' ? 'retried' : state;
  }
}
