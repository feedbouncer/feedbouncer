export const NEGATIVE_OUTCOMES = ['hide', 'remove', 'flag'] as const;

// Shared by the spike detector and the comments-list negative filter; `c` is the comment alias.
// Only enforced decisions count: suggestions and trial rules did not act on the comment.
export const NEGATIVE_COMMENT_SQL = `c.ingest_origin = 'live' AND NOT c.is_own_account AND EXISTS (SELECT 1 FROM decision d
  WHERE d.organization_id = c.organization_id AND d.brand_id = c.brand_id AND d.comment_id = c.id
    AND d.mode = 'enforce' AND d.outcome IN (${NEGATIVE_OUTCOMES.map((o) => `'${o}'`).join(',')}))`;
