// SQL helpers shared by the YouTube stores: every tenant statement binds the scope
// as $1 organization, $2 brand, $3 connection.
import type pg from 'pg';
import type { ConnectionScope } from '@feedbouncer/secrets';

export type Queryable = Pick<pg.ClientBase, 'query'>;

/** The scope as parameters $1..$3; null (OAuth-time ledger rows) binds three NULLs. */
export const scopeParams = (s: ConnectionScope | null): (string | null)[] => [
  s?.organizationId ?? null,
  s?.brandId ?? null,
  s?.connectionId ?? null,
];

/** The WHERE condition matching the scope of `scopeParams`, optionally on a table alias. */
export const scopedBy = (alias?: string): string => {
  const p = alias ? `${alias}.` : '';
  return `${p}organization_id = $1 AND ${p}brand_id = $2 AND ${p}connection_id = $3`;
};

export const SCOPED = scopedBy();
