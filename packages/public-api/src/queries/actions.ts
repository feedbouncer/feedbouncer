import type pg from 'pg';
import { ACTION_KINDS, type ActionRow } from '../resources/action.js';

/** One hide, unhide or public reply of the organization; any other action is not exposed. */
export async function loadPublicAction(
  db: pg.Pool | pg.ClientBase,
  org: string,
  id: string,
): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `SELECT id, kind, comment_id AS "commentId", status, outcome_code AS "outcomeCode",
            platform_ref AS "platformRef", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM moderation_action
      WHERE organization_id = $1 AND id = $2 AND kind = ANY($3)`,
    [org, id, ACTION_KINDS],
  );
  return rows[0] ?? null;
}
