import type pg from 'pg';
import { recordAuditEvent, withTransaction } from '@feedbouncer/db';
import { escapeHtml, type Mailer } from '@feedbouncer/mailer';
import { errorFields, type Logger, type Secret } from '@feedbouncer/service-runtime';
import {
  DISABLE_AFTER_CONSECUTIVE_FAILURES,
  DISABLE_MIN_FAILING_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  PER_ENDPOINT_IN_FLIGHT,
  PER_ORG_IN_FLIGHT,
  RETENTION_DAYS,
  RETRY_DELAYS_SECONDS,
} from './constants.js';
import { renderDisableEmail } from './disable-email.js';
import type { PgWebhookEndpoints } from './endpoints.js';
import type { WebhookMetrics } from './metrics.js';
import { renderEvent } from './render.js';
import { deliveryHeaders, signatureHeader } from './signing.js';
import type { TransportResult, WebhookTransport } from './transport.js';

const PURGE_BATCH = 1000;

/** The delay before the next attempt, or null when no attempt is left. */
export function nextAttemptDelaySeconds(
  attemptsSoFar: number,
  random: () => number,
): number | null {
  const base = RETRY_DELAYS_SECONDS[attemptsSoFar - 1];
  if (attemptsSoFar >= MAX_ATTEMPTS || base === undefined) return null;
  return Math.round(base * (0.9 + 0.2 * random()));
}

interface Claimed {
  id: string;
  organization_id: string;
  endpoint_id: string;
  event_id: string;
  attempts: number;
}

interface Target {
  url: URL;
  eventType: string;
}

type Outcome = 'succeeded' | 'retrying' | 'failed' | 'cancelled';

const CANDIDATES = `
  SELECT id, organization_id, ep_sending, org_sending FROM (
    SELECT e.id, e.organization_id, e.last_dispatched_at,
           (SELECT count(*)::int FROM webhook_delivery s
             WHERE s.endpoint_id = e.id AND s.status = 'sending') AS ep_sending,
           (SELECT count(*)::int FROM webhook_delivery s
             WHERE s.organization_id = e.organization_id AND s.status = 'sending') AS org_sending
      FROM webhook_endpoint e
     WHERE e.status = 'active'
       AND EXISTS (SELECT 1 FROM webhook_delivery d
                    WHERE d.endpoint_id = e.id AND d.status IN ('pending', 'retrying')
                      AND d.next_attempt_at <= $1)
  ) c
   WHERE ep_sending < $3 AND org_sending < $4
   ORDER BY last_dispatched_at ASC NULLS FIRST, id
   LIMIT $2`;

const DUE = `
  SELECT id FROM webhook_delivery
   WHERE organization_id = $1 AND endpoint_id = $2 AND status IN ('pending', 'retrying')
     AND next_attempt_at <= $3
   ORDER BY next_attempt_at, id
   LIMIT $4
   FOR UPDATE SKIP LOCKED`;

// Guarded by status and attempts, so a send whose lease was reaped and re-claimed records nothing.
const FINISH = `
  UPDATE webhook_delivery
     SET status = $4, lease_until = NULL, next_attempt_at = coalesce($5, next_attempt_at),
         last_error_code = $6, last_response_status = $7, last_duration_ms = $8, succeeded_at = $9
   WHERE organization_id = $1 AND id = $2 AND status = 'sending' AND attempts = $3`;

export class WebhookDispatcher {
  readonly #inFlight = new Set<Promise<void>>();
  readonly #now: () => Date;
  readonly #random: () => number;

  constructor(
    private readonly d: {
      pool: pg.Pool;
      endpoints: PgWebhookEndpoints;
      transport: WebhookTransport;
      mailer: Mailer | null;
      log: Logger;
      metrics: WebhookMetrics;
      concurrency: number;
      now?: () => Date;
      random?: () => number;
    },
  ) {
    this.#now = d.now ?? (() => new Date());
    this.#random = d.random ?? Math.random;
  }

  /** Claims due deliveries fairly across endpoints and starts sending them; does not wait for the sends. */
  async tick(): Promise<{ claimed: number }> {
    const free = this.d.concurrency - this.#inFlight.size;
    if (free <= 0) return { claimed: 0 };
    const now = this.#now();
    const claimed = await withTransaction(this.d.pool, (tx) => this.#claim(tx, free, now));
    for (const c of claimed) this.#launch(c);
    return { claimed: claimed.length };
  }

  /** Resolves once every send started so far has finished. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  /** Returns deliveries whose lease expired (the worker died mid-send) to the queue. */
  async reap(): Promise<number> {
    const r = await this.d.pool.query(
      `UPDATE webhook_delivery
          SET status = CASE WHEN attempts < $2 THEN 'retrying' ELSE 'failed' END,
              next_attempt_at = CASE WHEN attempts < $2 THEN $1 ELSE next_attempt_at END,
              last_error_code = 'outcome_unknown', lease_until = NULL
        WHERE status = 'sending' AND lease_until < $1`,
      [this.#now(), MAX_ATTEMPTS],
    );
    return r.rowCount ?? 0;
  }

  /** Deletes events past retention (their deliveries cascade), and expired previous secrets. */
  async purge(): Promise<number> {
    const now = this.#now();
    let events = 0;
    for (;;) {
      const r = await this.d.pool.query(
        `DELETE FROM webhook_event WHERE id IN (
           SELECT id FROM webhook_event
            WHERE created_at < $1::timestamptz - make_interval(days => $2) LIMIT $3)`,
        [now, RETENTION_DAYS, PURGE_BATCH],
      );
      events += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < PURGE_BATCH) break;
    }
    const rotations =
      (
        await this.d.pool.query(
          `UPDATE webhook_endpoint
              SET previous_signing_key_id = NULL, encrypted_previous_signing_secret = NULL,
                  rotation_overlap_until = NULL
            WHERE rotation_overlap_until <= $1`,
          [now],
        )
      ).rowCount ?? 0;
    if (events + rotations > 0) this.d.log.info('webhooks.purged', { events, rotations });
    return events + rotations;
  }

  async #claim(tx: pg.PoolClient, free: number, now: Date): Promise<Claimed[]> {
    const { rows: candidates } = await tx.query<{
      id: string;
      organization_id: string;
      ep_sending: number;
      org_sending: number;
    }>(CANDIDATES, [now, free, PER_ENDPOINT_IN_FLIGHT, PER_ORG_IN_FLIGHT]);
    const claimedPerOrg = new Map<string, number>();
    const ids: string[] = [];
    const touched: string[] = [];
    for (const c of candidates) {
      const left = free - ids.length;
      if (left === 0) break;
      const orgClaimed = claimedPerOrg.get(c.organization_id) ?? 0;
      const allowance = Math.min(
        PER_ENDPOINT_IN_FLIGHT - c.ep_sending,
        PER_ORG_IN_FLIGHT - c.org_sending - orgClaimed,
        left,
      );
      if (allowance <= 0) continue;
      const { rows } = await tx.query<{ id: string }>(DUE, [
        c.organization_id,
        c.id,
        now,
        allowance,
      ]);
      if (rows.length === 0) continue;
      ids.push(...rows.map((r) => r.id));
      touched.push(c.id);
      claimedPerOrg.set(c.organization_id, orgClaimed + rows.length);
    }
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Claimed>(
      `UPDATE webhook_delivery
          SET status = 'sending', attempts = attempts + 1, last_attempt_at = $2,
              lease_until = $2::timestamptz + make_interval(secs => $3)
        WHERE id = ANY($1::uuid[])
        RETURNING id, organization_id, endpoint_id, event_id, attempts`,
      [ids, now, LEASE_SECONDS],
    );
    await tx.query(
      'UPDATE webhook_endpoint SET last_dispatched_at = $2 WHERE id = ANY($1::uuid[])',
      [touched, now],
    );
    return rows;
  }

  #launch(c: Claimed): void {
    const p: Promise<void> = this.#send(c)
      .catch((err: unknown) =>
        this.d.log.error('webhooks.send_failed', {
          endpointId: c.endpoint_id,
          deliveryId: c.id,
          ...errorFields(err),
        }),
      )
      .finally(() => this.#inFlight.delete(p));
    this.#inFlight.add(p);
  }

  async #send(c: Claimed): Promise<void> {
    const client = await this.d.pool.connect();
    let prepared;
    try {
      prepared = await this.#prepare(client, c);
    } finally {
      client.release();
    }
    if (!prepared) return;
    const { target } = prepared;
    if (prepared.kind !== 'ok') {
      const code = prepared.kind === 'gone' ? 'subject_gone' : 'endpoint_disabled';
      const done = await this.d.pool.query(FINISH, [
        c.organization_id,
        c.id,
        c.attempts,
        'cancelled',
        null,
        code,
        null,
        null,
        null,
      ]);
      if (done.rowCount) this.#record(c, target, 'cancelled', code, null);
      return;
    }

    const timestampSec = Math.floor(this.#now().getTime() / 1000);
    const result = await this.d.transport.send({
      url: target.url,
      headers: deliveryHeaders({
        eventId: c.event_id,
        eventType: target.eventType,
        deliveryId: c.id,
        timestampSec,
        signature: signatureHeader(prepared.secrets, c.event_id, timestampSec, prepared.body),
      }),
      body: prepared.body,
    });
    if (result.ok) await this.#succeeded(c, target, result, prepared.occurredAt);
    else await this.#failed(c, target, result);
  }

  async #prepare(client: pg.PoolClient, c: Claimed) {
    const { rows } = await client.query<{ url: string; status: string; type: string }>(
      `SELECT ep.url, ep.status, ev.type
         FROM webhook_endpoint ep
         JOIN webhook_event ev ON ev.organization_id = ep.organization_id AND ev.id = $3
        WHERE ep.organization_id = $1 AND ep.id = $2`,
      [c.organization_id, c.endpoint_id, c.event_id],
    );
    const row = rows[0];
    if (!row) return null;
    const target: Target = { url: new URL(row.url), eventType: row.type };
    if (row.status !== 'active') return { kind: 'disabled' as const, target };
    const rendered = await renderEvent(client, c.organization_id, c.event_id);
    if (rendered.kind === 'gone') return { kind: 'gone' as const, target };
    const secrets: Secret[] = await this.d.endpoints.signingSecrets(
      client,
      c.organization_id,
      c.endpoint_id,
      this.#now(),
    );
    return {
      kind: 'ok' as const,
      target,
      secrets,
      body: rendered.body,
      occurredAt: rendered.occurredAt,
    };
  }

  async #succeeded(
    c: Claimed,
    target: Target,
    result: Extract<TransportResult, { ok: true }>,
    occurredAt: Date,
  ): Promise<void> {
    const now = this.#now();
    const recorded = await withTransaction(this.d.pool, async (tx) => {
      const done = await tx.query(FINISH, [
        c.organization_id,
        c.id,
        c.attempts,
        'succeeded',
        null,
        null,
        result.status,
        result.durationMs,
        now,
      ]);
      if (!done.rowCount) return false;
      await tx.query(
        `UPDATE webhook_endpoint SET consecutive_failures = 0, first_failure_at = NULL
          WHERE organization_id = $1 AND id = $2
            AND (consecutive_failures <> 0 OR first_failure_at IS NOT NULL)`,
        [c.organization_id, c.endpoint_id],
      );
      return true;
    });
    if (!recorded) return;
    this.d.metrics.lag((now.getTime() - occurredAt.getTime()) / 1000);
    this.#record(c, target, 'succeeded', null, result.status);
  }

  async #failed(
    c: Claimed,
    target: Target,
    result: Extract<TransportResult, { ok: false }>,
  ): Promise<void> {
    const now = this.#now();
    const delay = nextAttemptDelaySeconds(c.attempts, this.#random);
    const outcome = await withTransaction(this.d.pool, async (tx) => {
      const ep = await tx.query<{ status: string }>(
        'SELECT status FROM webhook_endpoint WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [c.organization_id, c.endpoint_id],
      );
      const active = ep.rows[0]?.status === 'active';
      // A retry is pointless on an endpoint that was disabled while this attempt was in flight.
      const status: Outcome = delay === null ? 'failed' : active ? 'retrying' : 'cancelled';
      const code = status === 'cancelled' ? 'endpoint_disabled' : result.code;
      const next = delay === null ? null : new Date(now.getTime() + delay * 1000);
      const done = await tx.query(FINISH, [
        c.organization_id,
        c.id,
        c.attempts,
        status,
        next,
        code,
        result.status,
        result.durationMs,
        null,
      ]);
      if (!done.rowCount) return null;
      const { rows } = await tx.query<{ consecutive_failures: number; first_failure_at: Date }>(
        `UPDATE webhook_endpoint
            SET consecutive_failures = consecutive_failures + 1,
                first_failure_at = coalesce(first_failure_at, $3)
          WHERE organization_id = $1 AND id = $2
          RETURNING consecutive_failures, first_failure_at`,
        [c.organization_id, c.endpoint_id, now],
      );
      const failures = rows[0]!.consecutive_failures;
      const since = rows[0]!.first_failure_at;
      const disable =
        active &&
        failures >= DISABLE_AFTER_CONSECUTIVE_FAILURES &&
        now.getTime() - since.getTime() >= DISABLE_MIN_FAILING_SECONDS * 1000;
      if (disable) await this.#disable(tx, c, now, failures, since);
      return {
        status: disable && status === 'retrying' ? ('cancelled' as const) : status,
        code: disable && status === 'retrying' ? 'endpoint_disabled' : code,
        disabled: disable ? { failures, since } : null,
      };
    });
    if (!outcome) return;
    this.#record(c, target, outcome.status, outcome.code, result.status);
    if (outcome.disabled) {
      this.d.metrics.disabled();
      this.d.log.warn('webhooks.endpoint_disabled', {
        endpointId: c.endpoint_id,
        host: target.url.hostname,
        failures: outcome.disabled.failures,
      });
      await this.#notifyDisabled(c, target, outcome.disabled.failures, outcome.disabled.since);
    }
  }

  async #disable(
    tx: pg.PoolClient,
    c: Claimed,
    now: Date,
    failures: number,
    since: Date,
  ): Promise<void> {
    await tx.query(
      `UPDATE webhook_endpoint
          SET status = 'disabled', disabled_reason = 'consecutive_failures', disabled_at = $3
        WHERE organization_id = $1 AND id = $2`,
      [c.organization_id, c.endpoint_id, now],
    );
    await tx.query(
      `UPDATE webhook_delivery SET status = 'cancelled', last_error_code = 'endpoint_disabled'
        WHERE organization_id = $1 AND endpoint_id = $2 AND status IN ('pending', 'retrying')`,
      [c.organization_id, c.endpoint_id],
    );
    await recordAuditEvent(tx, {
      organizationId: c.organization_id,
      actorType: 'system',
      action: 'webhook_endpoint.disabled',
      subjectType: 'webhook_endpoint',
      subjectId: c.endpoint_id,
      details: { failures, since: since.toISOString() },
    });
  }

  async #notifyDisabled(c: Claimed, target: Target, failures: number, since: Date): Promise<void> {
    const { mailer, log } = this.d;
    const fields = { endpointId: c.endpoint_id };
    if (!mailer) {
      log.warn('webhooks.disable_notify_skipped', { ...fields, reason: 'mail_not_configured' });
      return;
    }
    try {
      const { rows } = await this.d.pool.query<{ workspace: string; emails: string[] }>(
        `SELECT o.name AS workspace,
                coalesce((SELECT array_agg(DISTINCT lower(u.email)) FROM membership m
                            JOIN app_user u ON u.id = m.user_id
                           WHERE m.organization_id = o.id AND m.role IN ('owner', 'admin')
                             AND u.email_verified), '{}') AS emails
           FROM organization o WHERE o.id = $1`,
        [c.organization_id],
      );
      const row = rows[0];
      if (!row) return;
      const { subject, text } = renderDisableEmail({
        workspace: row.workspace,
        host: target.url.hostname,
        failures,
        since,
        endpointId: c.endpoint_id,
      });
      const html = `<!doctype html><html><body><p>${escapeHtml(text)}</p></body></html>`;
      const sent = await Promise.allSettled(
        row.emails.map((to) => mailer.send({ to, subject, text, html })),
      );
      for (const s of sent) {
        if (s.status === 'rejected')
          log.warn('webhooks.disable_notify_failed', { ...fields, ...errorFields(s.reason) });
      }
    } catch (err) {
      log.warn('webhooks.disable_notify_failed', { ...fields, ...errorFields(err) });
    }
  }

  #record(
    c: Claimed,
    target: Target,
    outcome: Outcome,
    code: string | null,
    status: number | null,
  ): void {
    this.d.metrics.attempt(outcome);
    this.d.log.info('webhooks.delivery_attempt', {
      endpointId: c.endpoint_id,
      host: target.url.hostname,
      deliveryId: c.id,
      eventType: target.eventType,
      attempt: c.attempts,
      outcome,
      code,
      status,
    });
  }
}
