// Integration-test helpers: alert channel and route seeding.
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
