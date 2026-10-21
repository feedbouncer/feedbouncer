import type pg from 'pg';

/**
 * Comments replying to one of $1, linked by parent id or, when not linked yet, by the
 * parent's external id on the same connection. Never one of $1 itself, nor one by an author
 * in $2 (those are being deleted too).
 */
const REPLIES = `
  NOT r.id = ANY($1::uuid[])
  AND (r.author_id IS NULL OR NOT r.author_id = ANY($2::uuid[]))
  AND ((r.connection_id, r.parent_comment_id) IN
         (SELECT connection_id, id FROM comment WHERE id = ANY($1::uuid[]))
       OR (r.parent_comment_id IS NULL AND (r.connection_id, r.parent_external_id) IN
         (SELECT connection_id, external_id FROM comment WHERE id = ANY($1::uuid[]))))`;

/**
 * Before the comments are deleted: their replies stay, marked as replying to a removed
 * comment and no longer pointing at it (the parent id is cleared by the foreign key).
 */
export async function markRepliesParentRemoved(
  tx: pg.ClientBase,
  commentIds: readonly string[],
  exceptAuthorIds: readonly string[] = [],
): Promise<number> {
  const r = await tx.query(
    `UPDATE comment r SET parent_removed_at = now(), parent_external_id = NULL WHERE ${REPLIES}`,
    [commentIds, exceptAuthorIds],
  );
  return r.rowCount ?? 0;
}

/** How many replies markRepliesParentRemoved would mark. */
export async function countReplies(
  c: pg.ClientBase,
  commentIds: readonly string[],
  exceptAuthorIds: readonly string[] = [],
): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM comment r WHERE ${REPLIES}`,
    [commentIds, exceptAuthorIds],
  );
  return Number(rows[0]?.n ?? 0);
}
