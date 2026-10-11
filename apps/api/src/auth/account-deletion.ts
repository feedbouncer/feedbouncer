import type pg from 'pg';
import { UserDeletionBlockedError, type AuthHooks } from './auth.js';

/**
 * Refuses to delete a user who is the only owner of an organization, because
 * the organization would be left without one. This check is a fast, friendly
 * denial (409 `sole_owner`), not the guarantee: if a co-owner leaves between
 * this query and the delete, the deferred last-owner trigger on `membership`
 * rejects the delete at commit and auth.ts reports that as the same 409. No
 * data is lost either way.
 */
export function createAccountDeletionHooks(pool: pg.Pool): AuthHooks {
  return {
    async beforeDeleteUser(userId) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM membership m
          WHERE m.user_id = $1 AND m.role = 'owner'
            AND NOT EXISTS (SELECT 1 FROM membership o
                             WHERE o.organization_id = m.organization_id
                               AND o.role = 'owner' AND o.user_id <> $1)
          LIMIT 1`,
        [userId],
      );
      if (rowCount) throw new UserDeletionBlockedError('sole owner');
    },
  };
}
