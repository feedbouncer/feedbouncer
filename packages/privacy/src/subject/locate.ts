import type pg from 'pg';
import type { SubjectIdentifierT } from './identifier.js';

/**
 * Finds the subject's author rows in one organization. External ids are compared with `=`
 * on bound parameters, so wildcard and quote characters are just characters; display names
 * and handles are never used.
 */
export async function locateAuthorIds(
  c: pg.Pool | pg.ClientBase,
  organizationId: string,
  subjects: readonly SubjectIdentifierT[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const s of subjects) {
    if (s.externalId === undefined) continue;
    const { rows } = await c.query<{ id: string }>(
      `SELECT a.id
         FROM author a JOIN connection c ON c.id = a.connection_id
        WHERE a.organization_id = $1 AND c.platform = $2 AND a.external_id = $3
          AND ($4::uuid IS NULL OR a.connection_id = $4::uuid)
        ORDER BY a.id`,
      [organizationId, s.platform, s.externalId, s.connectionId ?? null],
    );
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}
