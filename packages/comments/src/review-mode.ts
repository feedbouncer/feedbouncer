// Review mode for comments: which action kinds automation may not take while a
// connection's window is active. The window state itself lives with the connection
// directory (@feedbouncer/connectors), which stamps it on first activation.
import type pg from 'pg';
import { reviewModeState, type Clock } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { ActionKind } from './action-kinds.js';

/** Kinds that act on a comment or its author. Undo kinds (unhide, unban) stay automatic. */
export const GATED_KINDS: readonly ActionKind[] = Object.freeze([
  'hide',
  'delete',
  'ban_author',
  'public_reply',
  'private_reply',
] as const);

/** Whether a connection's review window is active now; false for an unknown or foreign connection. */
export class PgReviewModeReader {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock,
  ) {}

  async isActive(scope: ConnectionScope): Promise<boolean> {
    const { rows } = await this.pool.query<{
      review_mode: 'legacy' | 'on' | 'opted_out';
      review_mode_started_at: Date | null;
      review_mode_ends_at: Date | null;
      review_mode_ended_at: Date | null;
    }>(
      `SELECT review_mode, review_mode_started_at, review_mode_ends_at, review_mode_ended_at
         FROM connection
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    );
    const r = rows[0];
    return (
      r !== undefined &&
      reviewModeState(
        {
          mode: r.review_mode,
          startedAt: r.review_mode_started_at,
          endsAt: r.review_mode_ends_at,
          endedAt: r.review_mode_ended_at,
        },
        new Date(this.clock.now()),
      ) === 'active'
    );
  }
}
