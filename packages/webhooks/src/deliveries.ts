import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { ApiKeyContext, DeliveryOut, DeliveryStatus } from '@feedbouncer/public-api';
import { randomUUID } from 'node:crypto';
import { renderEvent } from './render.js';

export type { DeliveryOut, DeliveryStatus };

export class EndpointDisabledError extends Error {
  constructor() {
    super('The webhook endpoint is disabled');
    this.name = 'EndpointDisabledError';
  }
}

export class EventUnavailableError extends Error {
  constructor() {
    super('The event can no longer be rendered');
    this.name = 'EventUnavailableError';
  }
}

export class DeliveryInProgressError extends Error {
  constructor() {
    super('The delivery is still being attempted');
    this.name = 'DeliveryInProgressError';
  }
}

interface Row {
  id: string;
  event_id: string;
  event_type: string;
  kind: DeliveryOut['kind'];
  status: DeliveryStatus;
  attempts: number;
  last_attempt_at: Date | null;
  last_response_status: number | null;
  last_error_code: string | null;
  next_attempt_at: Date | null;
  succeeded_at: Date | null;
  created_at: Date;
}

const SELECT = `SELECT d.id, d.event_id, e.type AS event_type, d.kind, d.status, d.attempts,
    d.last_attempt_at, d.last_response_status, d.last_error_code, d.next_attempt_at,
    d.succeeded_at, d.created_at
  FROM webhook_delivery d
  JOIN webhook_event e ON e.organization_id = d.organization_id AND e.id = d.event_id`;

const iso = (d: Date | null) => d?.toISOString() ?? null;

const toOut = (r: Row): DeliveryOut => ({
  id: r.id,
  eventId: r.event_id,
  eventType: r.event_type,
  kind: r.kind,
  status: r.status,
  attempts: r.attempts,
  lastAttemptAt: iso(r.last_attempt_at),
  lastResponseStatus: r.last_response_status,
  lastErrorCode: r.last_error_code,
  nextAttemptAt: r.status === 'pending' || r.status === 'retrying' ? iso(r.next_attempt_at) : null,
  succeededAt: iso(r.succeeded_at),
  createdAt: r.created_at.toISOString(),
});

export class PgWebhookDeliveries {
  constructor(private readonly pool: pg.Pool) {}

  /** Null when the endpoint is not in the organization. */
  async list(
    org: string,
    endpointId: string,
    f: { status?: DeliveryStatus },
    page: { limit: number; after?: { t: Date; id: string } },
  ): Promise<{ rows: DeliveryOut[]; next: { t: Date; id: string } | null } | null> {
    const endpoint = await this.pool.query(
      'SELECT 1 FROM webhook_endpoint WHERE organization_id = $1 AND id = $2',
      [org, endpointId],
    );
    if (endpoint.rowCount === 0) return null;
    const params: unknown[] = [org, endpointId];
    const bind = (value: unknown) => `$${params.push(value)}`;
    const where: string[] = [];
    if (f.status) where.push(`d.status = ${bind(f.status)}`);
    if (page.after)
      where.push(`(d.created_at, d.id) < (${bind(page.after.t)}, ${bind(page.after.id)})`);
    const { rows } = await this.pool.query<Row>(
      `${SELECT}
        WHERE d.organization_id = $1 AND d.endpoint_id = $2${where.map((w) => `\n          AND ${w}`).join('')}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${bind(page.limit + 1)}`,
      params,
    );
    const kept = rows.slice(0, page.limit);
    const last = kept.at(-1);
    return {
      rows: kept.map(toOut),
      next: rows.length > page.limit && last ? { t: last.created_at, id: last.id } : null,
    };
  }

  /** Throws EndpointDisabledError; null when the endpoint is not in the organization. */
  async sendTest(ctx: ApiKeyContext, endpointId: string): Promise<DeliveryOut | null> {
    return withTransaction(this.pool, async (tx) => {
      const endpoint = await this.#lockEndpoint(tx, ctx.organizationId, endpointId);
      if (!endpoint) return null;
      if (endpoint.status === 'disabled') throw new EndpointDisabledError();
      const event = await tx.query<{ id: string }>(
        `INSERT INTO webhook_event (organization_id, type, dedupe_key, test_endpoint_id, occurred_at)
         VALUES ($1, 'webhook.test', $2, $3, now()) RETURNING id`,
        [ctx.organizationId, `test:${randomUUID()}`, endpointId],
      );
      return this.#insert(tx, ctx.organizationId, endpointId, event.rows[0]!.id, 'test');
    });
  }

  /** Throws EndpointDisabledError, EventUnavailableError or DeliveryInProgressError; null when the delivery is not the endpoint's. */
  async redeliver(
    ctx: ApiKeyContext,
    endpointId: string,
    deliveryId: string,
  ): Promise<DeliveryOut | null> {
    return withTransaction(this.pool, async (tx) => {
      const endpoint = await this.#lockEndpoint(tx, ctx.organizationId, endpointId);
      if (!endpoint) return null;
      const source = await tx.query<{ event_id: string; status: DeliveryStatus }>(
        `SELECT event_id, status FROM webhook_delivery
          WHERE organization_id = $1 AND endpoint_id = $2 AND id = $3`,
        [ctx.organizationId, endpointId, deliveryId],
      );
      if (!source.rows[0]) return null;
      if (endpoint.status === 'disabled') throw new EndpointDisabledError();
      const { event_id: eventId, status } = source.rows[0];
      if (status === 'pending' || status === 'sending' || status === 'retrying')
        throw new DeliveryInProgressError();
      if ((await renderEvent(tx, ctx.organizationId, eventId)).kind === 'gone')
        throw new EventUnavailableError();
      return this.#insert(tx, ctx.organizationId, endpointId, eventId, 'redelivery');
    });
  }

  #lockEndpoint(tx: pg.ClientBase, org: string, id: string) {
    return tx
      .query<{
        status: 'active' | 'disabled';
      }>('SELECT status FROM webhook_endpoint WHERE organization_id = $1 AND id = $2 FOR SHARE', [
        org,
        id,
      ])
      .then((r) => r.rows[0]);
  }

  async #insert(
    tx: pg.ClientBase,
    org: string,
    endpointId: string,
    eventId: string,
    kind: 'test' | 'redelivery',
  ): Promise<DeliveryOut> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO webhook_delivery (organization_id, endpoint_id, event_id, kind)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [org, endpointId, eventId, kind],
    );
    const created = await tx.query<Row>(`${SELECT} WHERE d.organization_id = $1 AND d.id = $2`, [
      org,
      rows[0]!.id,
    ]);
    return toOut(created.rows[0]!);
  }
}
