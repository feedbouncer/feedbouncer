import type pg from 'pg';
import type { BrandScope } from '../tenancy/brand-scope.js';

/** Withdraws a run or preview whose jobs could not be enqueued. Results and run rows go with it. */
export async function withdraw(
  pool: pg.Pool,
  table: 'policy_run' | 'policy_preview',
  scope: BrandScope,
  id: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM ${table} WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
    [scope.organizationId, scope.brandId, id],
  );
}
