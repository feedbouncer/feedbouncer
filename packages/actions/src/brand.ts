import type pg from 'pg';
import type { BrandConnectionInfo } from './support.js';
import type { BrandScope } from '@feedbouncer/comments';
import type { ConnectorCapabilities, Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';

/** The brand's live connections whose connector is registered, with granted scopes. */
export async function loadBrandConnections(
  db: pg.Pool | pg.PoolClient,
  scope: BrandScope,
  capabilities: (p: Platform) => ConnectorCapabilities | undefined,
): Promise<BrandConnectionInfo[]> {
  const { rows } = await db.query<{ id: string; platform: Platform; granted_scopes: string[] }>(
    `SELECT id, platform, granted_scopes FROM connection
      WHERE organization_id = $1 AND brand_id = $2 AND status <> 'revoked'
      ORDER BY created_at, id`,
    [scope.organizationId, scope.brandId],
  );
  return rows.flatMap((r) => {
    const caps = capabilities(r.platform);
    return caps
      ? [{ connectionId: r.id, platform: r.platform, grantedScopes: r.granted_scopes, caps }]
      : [];
  });
}

export async function loadBrandName(
  db: pg.Pool | pg.PoolClient,
  scope: BrandScope,
): Promise<string> {
  const { rows } = await db.query<{ name: string }>(
    'SELECT name FROM brand WHERE organization_id = $1 AND id = $2',
    [scope.organizationId, scope.brandId],
  );
  return rows[0]?.name ?? '';
}

/** One connection of the brand, or null when it is revoked or its connector is not registered. */
export async function loadConnectionInfo(
  db: pg.Pool | pg.PoolClient,
  scope: ConnectionScope,
  capabilities: (p: Platform) => ConnectorCapabilities | undefined,
): Promise<BrandConnectionInfo | null> {
  const all = await loadBrandConnections(db, scope, capabilities);
  return all.find((c) => c.connectionId === scope.connectionId) ?? null;
}
