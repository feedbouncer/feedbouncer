// Integration-test helpers: alert channel, route and comment seeding.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Tenant } from '@feedbouncer/db/testing';
import type { AlertType } from './settings.js';

export type SeedChannelStatus = 'pending_confirmation' | 'active' | 'disconnected' | 'unsubscribed';

export async function seedChannel(
  c: pg.ClientBase,
  tenant: Tenant,
  kind: 'slack' | 'email',
  status: SeedChannelStatus = 'active',
): Promise<string> {
  const id = randomUUID();
  if (kind === 'slack') {
    await c.query(
      `INSERT INTO alert_channel (organization_id, kind, label, status, key_id, encrypted_webhook_url, webhook_hint)
       VALUES ($1, 'slack', $2, $3, 'k1', '\\x00'::bytea, '...test')`,
      [tenant.organizationId, `slack-${id}`, status],
    );
  } else {
    await c.query(
      `INSERT INTO alert_channel (organization_id, kind, label, status, key_id, email, unsubscribe_key_sha256,
         encrypted_unsubscribe_token)
       VALUES ($1, 'email', $2, $3, 'k1', $4, $5, '\\x00'::bytea)`,
      [
        tenant.organizationId,
        `email-${id}`,
        status,
        `${id}@example.test`,
        Buffer.from(id.replaceAll('-', ''), 'hex'),
      ],
    );
  }
  return (
    await c.query<{ id: string }>(
      'SELECT id FROM alert_channel WHERE organization_id = $1 AND label = $2',
      [tenant.organizationId, `${kind}-${id}`],
    )
  ).rows[0]!.id;
}

export async function enableRoute(
  c: pg.ClientBase,
  tenant: Tenant,
  alertType: AlertType,
  channelId: string,
  enabled = true,
): Promise<void> {
  await c.query(
    `INSERT INTO alert_route (organization_id, brand_id, alert_type, channel_id, enabled, enabled_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN now() END)`,
    [tenant.organizationId, tenant.brandId, alertType, channelId, enabled],
  );
}

/** Inserts `count` comments, each with one decision of `outcome` (default 'hide'). */
export async function seedNegativeComments(
  c: pg.ClientBase,
  tenant: Tenant,
  o: {
    count: number;
    postedAt: Date;
    origin?: 'live' | 'backfill';
    outcome?: 'hide' | 'flag' | 'approve';
    ingestedAt?: Date;
  },
): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at,
       ingested_at, ingest_origin)
     SELECT $1, $2, $3, $4, $5 || '-' || i, 'seeded', $6, $7, $8 FROM generate_series(1, $9::int) i
     RETURNING id`,
    [
      tenant.organizationId,
      tenant.brandId,
      tenant.connectionId,
      tenant.sourceId,
      randomUUID(),
      o.postedAt,
      o.ingestedAt ?? o.postedAt,
      o.origin ?? 'live',
      o.count,
    ],
  );
  const ids = r.rows.map((x) => x.id);
  await c.query(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, classifier_provider,
       classifier_model, reason)
     SELECT $1, $2, id, $4, 'enforce', 'classifier', 'test', 'test-model', 'seeded' FROM unnest($3::uuid[]) id`,
    [tenant.organizationId, tenant.brandId, ids, o.outcome ?? 'hide'],
  );
  return ids;
}

/** Inserts `count` live (or backfill) comments flagged by the classifier; their review items are created at `createdAt`. */
export async function seedFlags(
  c: pg.ClientBase,
  tenant: Tenant,
  o: { count: number; createdAt: Date; origin?: 'live' | 'backfill' },
): Promise<string[]> {
  const commentIds = await seedNegativeComments(c, tenant, {
    count: o.count,
    postedAt: o.createdAt,
    outcome: 'flag',
    ...(o.origin ? { origin: o.origin } : {}),
  });
  const r = await c.query<{ id: string }>(
    `UPDATE review_item SET created_at = $3
      WHERE organization_id = $1 AND comment_id = ANY($2::uuid[])
      RETURNING id`,
    [tenant.organizationId, commentIds, o.createdAt],
  );
  return r.rows.map((x) => x.id);
}
