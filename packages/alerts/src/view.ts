import type pg from 'pg';
import type { Platform } from '@feedbouncer/connectors';
import type { AlertPayload, CapPayload } from './events.js';
import { excerpt } from './excerpt.js';
import { reviewLink, settingsLink, spikeLink } from './links.js';

export type AlertKind = 'negative_spike' | 'spike_escalation' | 'flagged_digest' | 'cap_reached';

export interface AlertView {
  type: AlertKind;
  organizationId: string;
  workspaceName: string;
  brand: { id: string; name: string; timezone: string } | null;
  accounts: { name: string; platform: Platform }[];
  moreAccounts: number;
  window: { from: Date; to: Date } | null;
  counts: Record<string, number>;
  excerpts: string[];
  link: string;
  /** Flags still open at render time. */
  liveItemCount?: number;
}

const MAX_ACCOUNTS = 5;
const MAX_EXCERPTS = 3;

interface EventRow {
  alert_type: AlertKind;
  brand_id: string | null;
  window_start: Date;
  window_end: Date;
  payload: AlertPayload | CapPayload;
}

async function accounts(
  pool: pg.Pool,
  org: string,
  brand: string,
  connectionIds: string[],
): Promise<AlertView['accounts']> {
  const r = await pool.query<{ name: string; platform: Platform }>(
    `SELECT COALESCE(display_name, external_account_id) AS name, platform FROM connection
      WHERE organization_id = $1 AND brand_id = $2 AND id = ANY($3::uuid[])
      ORDER BY name, id LIMIT ${MAX_ACCOUNTS}`,
    [org, brand, connectionIds],
  );
  return r.rows.map((x) => ({ name: x.name, platform: x.platform }));
}

export async function loadAlertView(
  pool: pg.Pool,
  web: URL,
  eventId: string,
  organizationId: string,
): Promise<AlertView | null> {
  const org = organizationId;
  const ev = await pool.query<EventRow & { workspace: string }>(
    `SELECT e.alert_type, e.brand_id, e.window_start, e.window_end, e.payload, o.name AS workspace
       FROM alert_event e JOIN organization o ON o.id = e.organization_id
      WHERE e.organization_id = $1 AND e.id = $2`,
    [org, eventId],
  );
  const e = ev.rows[0];
  if (!e) return null;
  const base = { type: e.alert_type, organizationId: org, workspaceName: e.workspace };

  if (e.payload.kind === 'cap') {
    return {
      ...base,
      brand: null,
      accounts: [],
      moreAccounts: 0,
      window: null,
      counts: { cap: e.payload.cap, resumesAt: Date.parse(e.payload.resumesAt) },
      excerpts: [],
      link: settingsLink(web, org),
    };
  }

  const brandId = e.brand_id;
  if (brandId === null) return null;
  const b = await pool.query<{ name: string; timezone: string; excerpts: boolean }>(
    `SELECT b.name, b.timezone, COALESCE(s.content_mode, 'excerpts') = 'excerpts' AS excerpts
       FROM brand b
       LEFT JOIN alert_brand_settings s ON s.organization_id = b.organization_id AND s.brand_id = b.id
      WHERE b.organization_id = $1 AND b.id = $2 AND b.archived_at IS NULL`,
    [org, brandId],
  );
  const brand = b.rows[0];
  if (!brand) return null;
  const scoped = {
    ...base,
    brand: { id: brandId, name: brand.name, timezone: brand.timezone },
    window: { from: e.window_start, to: e.window_end },
  };

  if (e.payload.kind === 'spike') {
    const p = e.payload;
    const [acc, bodies] = await Promise.all([
      accounts(pool, org, brandId, p.connectionIds),
      brand.excerpts
        ? pool.query<{ body: string }>(
            `SELECT body FROM comment
              WHERE organization_id = $1 AND brand_id = $2 AND id = ANY($3::uuid[])
                AND platform_state <> 'deleted'
              ORDER BY posted_at DESC, id LIMIT ${MAX_EXCERPTS}`,
            [org, brandId, p.commentIds],
          )
        : null,
    ]);
    return {
      ...scoped,
      accounts: acc,
      moreAccounts: Math.max(p.connectionCount - acc.length, 0),
      counts: {
        negatives: p.negatives,
        total: p.total,
        expectedPerHour: p.expectedPerHour,
        ...(p.triggerCount !== undefined && { triggerCount: p.triggerCount }),
      },
      excerpts: bodies?.rows.map((x) => excerpt(x.body)) ?? [],
      link: spikeLink(web, org, brandId, e.window_start, e.window_end),
    };
  }

  const p = e.payload;
  const items = await pool.query<{ live: number; connection_ids: string[] }>(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS live,
            COALESCE(array_agg(DISTINCT connection_id) FILTER (WHERE status = 'open'), '{}') AS connection_ids
       FROM review_item
      WHERE organization_id = $1 AND brand_id = $2 AND id = ANY($3::uuid[])`,
    [org, brandId, p.reviewItemIds],
  );
  const { live, connection_ids: connectionIds } = items.rows[0]!;
  const [acc, bodies] = await Promise.all([
    accounts(pool, org, brandId, connectionIds),
    brand.excerpts
      ? pool.query<{ body: string }>(
          `SELECT c.body FROM review_item r
             JOIN comment c ON c.organization_id = r.organization_id AND c.brand_id = r.brand_id
                           AND c.id = r.comment_id
            WHERE r.organization_id = $1 AND r.brand_id = $2 AND r.id = ANY($3::uuid[])
              AND r.status = 'open' AND c.platform_state <> 'deleted'
            ORDER BY c.posted_at DESC, c.id LIMIT ${MAX_EXCERPTS}`,
          [org, brandId, p.reviewItemIds],
        )
      : null,
  ]);
  return {
    ...scoped,
    accounts: acc,
    moreAccounts: Math.max(connectionIds.length - acc.length, 0),
    counts: { count: p.count },
    excerpts: bodies?.rows.map((x) => excerpt(x.body)) ?? [],
    link: reviewLink(web, org, brandId),
    liveItemCount: live,
  };
}
