// Persists the states suggestions have already reached on the clock or on the comment, so lists
// and counts need not recompute them. System-level and idempotent; logs counts only.
import type pg from 'pg';
import type { Clock } from '@feedbouncer/connectors';
import type { Logger } from '@feedbouncer/service-runtime';
import { BODY_CHANGED_SQL, GRACE_SQL } from './suggestions.js';

const BATCH = 500;

// not_applicable wins over expired, as in the effective status.
const NOT_APPLICABLE_SQL = `
  WITH due AS (
    SELECT s.ctid AS tid,
           CASE WHEN c.platform_state = 'deleted' THEN 'comment_gone' ELSE 'comment_edited' END AS reason
      FROM action_suggestion s
      JOIN comment c ON c.organization_id = s.organization_id AND c.brand_id = s.brand_id AND c.id = s.comment_id
     WHERE s.status = 'pending' AND (c.platform_state = 'deleted' OR ${BODY_CHANGED_SQL})
     LIMIT ${BATCH}
       FOR UPDATE OF s SKIP LOCKED)
  UPDATE action_suggestion s
     SET status = 'not_applicable', status_reason = due.reason, decided_at = now()
    FROM due
   WHERE s.ctid = due.tid`;

const EXPIRED_SQL = `
  UPDATE action_suggestion
     SET status = 'expired', status_reason = 'grace_period_ended', decided_at = now()
   WHERE ctid IN (
     SELECT s.ctid
       FROM action_suggestion s
       JOIN connection cn ON cn.organization_id = s.organization_id AND cn.brand_id = s.brand_id AND cn.id = s.connection_id
      WHERE s.status = 'pending' AND ${GRACE_SQL} <= $1
      LIMIT ${BATCH}
        FOR UPDATE OF s SKIP LOCKED)`;

export class ReviewModeSweeper {
  constructor(private readonly d: { pool: pg.Pool; clock: Clock; log: Logger }) {}

  async tick(): Promise<{ expired: number; notApplicable: number }> {
    const notApplicable = await this.d.pool.query(NOT_APPLICABLE_SQL);
    const expired = await this.d.pool.query(EXPIRED_SQL, [new Date(this.d.clock.now())]);
    const result = { expired: expired.rowCount ?? 0, notApplicable: notApplicable.rowCount ?? 0 };
    if (result.expired + result.notApplicable > 0) this.d.log.info('review_mode_sweep', result);
    return result;
  }
}
