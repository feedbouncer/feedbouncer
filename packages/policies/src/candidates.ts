// The comments policy evaluation would consider outside the live path: rules
// evaluated the current body of a live, visible, third-party comment and decided
// nothing. Previews and runs share this one query.
import type pg from 'pg';
import type { JobContext } from '@feedbouncer/jobs';
import type { BrandScope } from '@feedbouncer/rules';

export interface CandidateComment {
  commentId: string;
  connectionId: string;
  platform: JobContext['platform'];
  /** sha256 (hex) of the stored body, as rule evaluation recorded it. */
  bodySha256: string;
}

/** Newest first. `connectionId` narrows to one connection of the brand. */
export async function recentUndecidedComments(
  q: Pick<pg.ClientBase, 'query'>,
  s: BrandScope,
  o: { since: Date; limit: number; connectionId?: string },
): Promise<CandidateComment[]> {
  const { rows } = await q.query<{
    id: string;
    connection_id: string;
    platform: JobContext['platform'];
    body_sha256: string;
  }>(
    `SELECT c.id, c.connection_id, cn.platform, encode(re.body_sha256, 'hex') AS body_sha256
       FROM comment c
       JOIN connection cn
         ON cn.organization_id = c.organization_id AND cn.brand_id = c.brand_id AND cn.id = c.connection_id
       JOIN LATERAL (
         SELECT e.status, e.body_sha256 FROM rule_evaluation e
          WHERE e.organization_id = c.organization_id AND e.brand_id = c.brand_id
            AND e.comment_id = c.id AND e.trigger_key = 'ingest'
            AND e.body_sha256 = sha256(convert_to(c.body, 'UTF8'))
          ORDER BY e.created_at DESC LIMIT 1
       ) re ON re.status = 'no_match'
      WHERE c.organization_id = $1 AND c.brand_id = $2
        AND ($5::uuid IS NULL OR c.connection_id = $5)
        AND c.ingest_origin = 'live' AND c.platform_state <> 'deleted'
        AND NOT c.is_own_account AND c.posted_at >= $3
      ORDER BY c.posted_at DESC, c.id
      LIMIT $4`,
    [s.organizationId, s.brandId, o.since, o.limit, o.connectionId ?? null],
  );
  return rows.map((r) => ({
    commentId: r.id,
    connectionId: r.connection_id,
    platform: r.platform,
    bodySha256: r.body_sha256,
  }));
}
