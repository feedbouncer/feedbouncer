/** Boolean SQL: the comment `alias` has a reply, applied through FeedBouncer or posted by the account itself. */
export function repliedSql(alias: string): string {
  return `(EXISTS (SELECT 1 FROM moderation_action ma
                    WHERE ma.comment_id = ${alias}.id AND ma.kind = 'public_reply' AND ma.status = 'applied')
       OR EXISTS (SELECT 1 FROM comment rc
                   WHERE rc.parent_comment_id = ${alias}.id AND rc.is_own_account
                     AND rc.platform_state <> 'deleted'))`;
}

/** Boolean SQL: a visible comment from someone else that nobody has replied to. */
export function unansweredSql(alias: string): string {
  return `(NOT ${alias}.is_own_account AND ${alias}.platform_state = 'visible' AND NOT ${repliedSql(alias)})`;
}
