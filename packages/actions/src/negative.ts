export const NEGATIVE_OUTCOMES = ['hide', 'remove', 'flag'] as const;

// Shared by the comments list and the spike detector; `c` is the comment alias.
export const NEGATIVE_COMMENT_SQL = `c.ingest_origin = 'live' AND NOT c.is_own_account AND EXISTS (SELECT 1 FROM decision d
  WHERE d.organization_id = c.organization_id AND d.brand_id = c.brand_id AND d.comment_id = c.id
    AND d.outcome IN (${NEGATIVE_OUTCOMES.map((o) => `'${o}'`).join(',')}))`;
