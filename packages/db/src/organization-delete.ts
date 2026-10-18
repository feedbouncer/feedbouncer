import type pg from 'pg';

export type OrganizationDeleteResult =
  | 'deleted'
  | 'not_found'
  | 'confirmation_mismatch'
  | 'connections_active';

/**
 * Deletes an organization once FeedBouncer holds no platform access in it:
 * every connection revoked and its stored credentials deleted by the teardown
 * job (which also unsubscribes the platform webhooks). Deleting earlier would
 * cascade the credentials away and leave the account subscribed.
 *
 * Call inside a transaction. The organization row and then its connections are
 * locked before the check, so nothing can connect, reconnect or store
 * credentials between the check and the delete.
 */
export async function deleteOrganization(
  c: pg.ClientBase,
  organizationId: string,
  confirmName: string,
): Promise<OrganizationDeleteResult> {
  const org = await c.query<{ name: string }>(
    'SELECT name FROM organization WHERE id = $1 FOR UPDATE',
    [organizationId],
  );
  if (!org.rows[0]) return 'not_found';
  if (org.rows[0].name !== confirmName) return 'confirmation_mismatch';
  await c.query('SELECT 1 FROM connection WHERE organization_id = $1 FOR UPDATE', [
    organizationId,
  ]);
  const { rows } = await c.query<{ active: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM connection WHERE organization_id = $1 AND status <> 'revoked')
         OR EXISTS (SELECT 1 FROM connection_secret s JOIN connection c ON c.id = s.connection_id
                     WHERE c.organization_id = $1) AS active`,
    [organizationId],
  );
  if (rows[0]!.active) return 'connections_active';
  await c.query('DELETE FROM organization WHERE id = $1', [organizationId]);
  return 'deleted';
}
