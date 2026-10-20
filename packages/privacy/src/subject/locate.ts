import type pg from 'pg';
import type { SubjectIdentifierT } from './identifier.js';

/** Where a subject's data is, within one organization. */
export interface SubjectMatch {
  /** author rows whose platform id equals a requested external id. */
  authorIds: string[];
  /** The connections those author rows belong to. */
  connectionIds: string[];
  /** The requested external ids, found or not: rule entries may hold them either way. */
  externalIds: string[];
  /** The requested handles. They match rule entries only, never author rows. */
  handles: string[];
}

/**
 * Finds the subject's author rows in one organization. External ids are compared with `=`
 * on bound parameters, so wildcard and quote characters are just characters; display names
 * are never used.
 */
export async function locateSubject(
  c: pg.Pool | pg.ClientBase,
  organizationId: string,
  subjects: readonly SubjectIdentifierT[],
): Promise<SubjectMatch> {
  const authors = new Map<string, string>();
  const externalIds = new Set<string>();
  const handles = new Set<string>();
  for (const s of subjects) {
    if (s.handle !== undefined) handles.add(s.handle);
    if (s.externalId === undefined) continue;
    externalIds.add(s.externalId);
    const { rows } = await c.query<{ id: string; connection_id: string }>(
      `SELECT a.id, a.connection_id, a.external_id
         FROM author a JOIN connection c ON c.id = a.connection_id
        WHERE a.organization_id = $1 AND c.platform = $2 AND a.external_id = $3
          AND ($4::uuid IS NULL OR a.connection_id = $4::uuid)
        ORDER BY a.id`,
      [organizationId, s.platform, s.externalId, s.connectionId ?? null],
    );
    for (const r of rows) authors.set(r.id, r.connection_id);
  }
  return {
    authorIds: [...authors.keys()],
    connectionIds: [...new Set(authors.values())],
    externalIds: [...externalIds],
    handles: [...handles],
  };
}
