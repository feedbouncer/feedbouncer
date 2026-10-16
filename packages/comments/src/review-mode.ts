// Review mode for comments: which action kinds automation may not take while a
// connection's window is active, and the window read used by the jobs that
// record evaluations. The window state itself lives with the connection
// directory (@feedbouncer/connectors), which stamps it on first activation.
import type pg from 'pg';
import type { Clock, ReviewMode, ReviewModeColumns } from '@feedbouncer/connectors';
import { reviewModeState } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { UUID } from '@feedbouncer/service-runtime';
import type { ActionKind } from './action-kinds.js';

export {
  REVIEW_GRACE_MS,
  REVIEW_WINDOW_MS,
  graceEndsAt,
  reviewModeState,
  type ReviewModeColumns,
  type ReviewModeState,
} from '@feedbouncer/connectors';

/** Kinds that act on a comment or its author. Undo kinds (unhide, unban) stay automatic. */
export const GATED_KINDS: readonly ActionKind[] = Object.freeze([
  'hide',
  'delete',
  'ban_author',
  'public_reply',
  'private_reply',
] as const);

export class PgReviewModeReader {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock,
  ) {}

  /** Snapshot used by the rules/classifier/policy jobs at record time. */
  async isActive(scope: ConnectionScope): Promise<boolean> {
    const c = await this.load(scope);
    return c !== null && reviewModeState(c, new Date(this.clock.now())) === 'active';
  }

  async load(scope: ConnectionScope): Promise<ReviewModeColumns | null> {
    if (![scope.organizationId, scope.brandId, scope.connectionId].every((id) => UUID.test(id)))
      return null;
    const r = await this.pool.query<{
      review_mode: ReviewMode;
      review_mode_started_at: Date | null;
      review_mode_ends_at: Date | null;
      review_mode_ended_at: Date | null;
    }>(
      `SELECT review_mode, review_mode_started_at, review_mode_ends_at, review_mode_ended_at
         FROM connection WHERE id = $3 AND organization_id = $1 AND brand_id = $2`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    );
    const row = r.rows[0];
    return row
      ? {
          mode: row.review_mode,
          startedAt: row.review_mode_started_at,
          endsAt: row.review_mode_ends_at,
          endedAt: row.review_mode_ended_at,
        }
      : null;
  }
}
