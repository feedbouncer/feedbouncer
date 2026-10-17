import type pg from 'pg';
import type { Sensitivity } from './spike.js';
import type { AlertType } from './settings.js';

export type AlertEventType = 'negative_spike' | 'spike_escalation' | 'flagged_digest';

export type AlertPayload =
  | {
      kind: 'spike';
      negatives: number;
      total: number;
      expectedPerHour: number;
      trigger: 'volume' | 'share';
      sensitivity: Sensitivity;
      minCount: number;
      triggerCount?: number;
      commentIds: string[];
      connectionIds: string[];
      connectionCount: number;
    }
  | { kind: 'flags'; reviewItemIds: string[]; count: number };

export interface CapPayload {
  kind: 'cap';
  cap: number;
  resumesAt: string;
}

export interface NewAlertEvent {
  organizationId: string;
  brandId: string;
  type: AlertEventType;
  key: string;
  windowStart: Date;
  windowEnd: Date;
  payload: AlertPayload;
}

export type CreateResult =
  | { status: 'created'; eventId: string; suppressed: boolean; deliveries: number }
  | { status: 'duplicate'; eventId: string };

const HOUR_MS = 3_600_000;

/** The cap notice is workspace-wide: every active channel hears it, whatever its brand routes. */
async function queueCapDeliveries(
  c: pg.ClientBase,
  organizationId: string,
  eventId: string,
): Promise<void> {
  await c.query(
    `INSERT INTO alert_delivery (organization_id, alert_event_id, channel_id, state)
     SELECT ch.organization_id, $2, ch.id, 'pending'
     FROM alert_channel ch
     WHERE ch.organization_id = $1 AND ch.status = 'active'
     ON CONFLICT (alert_event_id, channel_id) DO NOTHING`,
    [organizationId, eventId],
  );
}

async function queueDeliveries(
  c: pg.ClientBase,
  organizationId: string,
  eventId: string,
  brandId: string,
  routeType: AlertType,
): Promise<number> {
  const r = await c.query(
    `INSERT INTO alert_delivery (organization_id, alert_event_id, channel_id, state)
     SELECT r.organization_id, $2, r.channel_id, 'pending'
     FROM alert_route r
     JOIN alert_channel ch ON ch.organization_id = r.organization_id AND ch.id = r.channel_id
     WHERE r.organization_id = $1 AND r.brand_id = $3 AND r.alert_type = $4 AND r.enabled
       AND ch.status = 'active'
     ON CONFLICT (alert_event_id, channel_id) DO NOTHING`,
    [organizationId, eventId, brandId, routeType],
  );
  return r.rowCount ?? 0;
}

export async function createAlertEvent(
  c: pg.ClientBase,
  e: NewAlertEvent,
  opts: { capPerHour: number; routeType: AlertType; now: Date },
): Promise<CreateResult> {
  const org = e.organizationId;
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, window_start, window_end,
       payload, created_at)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8)
     ON CONFLICT (organization_id, alert_key) DO NOTHING
     RETURNING id`,
    [org, e.brandId, e.type, e.key, e.windowStart, e.windowEnd, e.payload, opts.now],
  );
  if (inserted.rowCount === 0) {
    const existing = await c.query<{ id: string }>(
      'SELECT id FROM alert_event WHERE organization_id = $1 AND alert_key = $2',
      [org, e.key],
    );
    return { status: 'duplicate', eventId: existing.rows[0]!.id };
  }
  const eventId = inserted.rows[0]!.id;

  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('alert-cap:' || $1::text, 0))", [
    org,
  ]);
  const since = new Date(opts.now.getTime() - HOUR_MS);
  const recent = await c.query<{ n: string; oldest: Date | null }>(
    `SELECT count(*) AS n, min(created_at) AS oldest FROM alert_event
     WHERE organization_id = $1 AND status = 'queued' AND alert_type <> 'cap_reached'
       AND created_at > $2 AND id <> $3`,
    [org, since, eventId],
  );
  const { n, oldest } = recent.rows[0]!;

  if (Number(n) < opts.capPerHour) {
    const deliveries = await queueDeliveries(c, org, eventId, e.brandId, opts.routeType);
    return { status: 'created', eventId, suppressed: false, deliveries };
  }

  await c.query(
    "UPDATE alert_event SET status = 'suppressed' WHERE organization_id = $1 AND id = $2",
    [org, eventId],
  );
  const hour = new Date(Math.floor(opts.now.getTime() / HOUR_MS) * HOUR_MS);
  const resumesAt = new Date(oldest!.getTime() + HOUR_MS);
  const cap = await c.query<{ id: string }>(
    `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, window_start, window_end,
       payload, created_at)
     VALUES ($1, NULL, 'cap_reached', $2, 'queued', $3, $4, $5, $6)
     ON CONFLICT (organization_id, alert_key) DO UPDATE SET payload = EXCLUDED.payload
     RETURNING id`,
    [
      org,
      `cap:${org}:${hour.toISOString()}`,
      hour,
      opts.now,
      {
        kind: 'cap',
        cap: opts.capPerHour,
        resumesAt: resumesAt.toISOString(),
      } satisfies CapPayload,
      opts.now,
    ],
  );
  await queueCapDeliveries(c, org, cap.rows[0]!.id);
  return { status: 'created', eventId, suppressed: true, deliveries: 0 };
}
