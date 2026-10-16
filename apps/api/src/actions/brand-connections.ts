import type pg from 'pg';
import type { BrandConnectionInfo } from '@feedbouncer/actions';
import type { BrandScope } from '@feedbouncer/comments';
import type { ConnectorCapabilities, Platform } from '@feedbouncer/connectors';

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
