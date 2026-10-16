// Review queue: comments waiting for a person. At most one open item per comment (partial
// unique index). Every statement filters organization_id + brand_id (plus connection_id on
// writes that carry a connection scope) and is parameterised. commentBody is returned to the
// caller for display and must never be logged.
import type pg from 'pg';
import type { Platform } from '@feedbouncer/connectors';
import type { BrandScope } from '@feedbouncer/comments';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { clampLimit } from './support.js';

export type ReviewResolution = 'approved' | 'hidden' | 'deleted' | 'banned' | 'dismissed';

export interface ReviewItemView {
  id: string;
  commentId: string;
  connectionId: string;
  source: string;
  ruleId: string | null;
  ruleName: string | null;
  status: 'open' | 'resolved';
  resolution: ReviewResolution | null;
  createdAt: Date;
  resolvedAt: Date | null;
  commentBody: string;
  authorName: string | null;
  platform: Platform;
}

interface ItemDb {
  id: string;
  comment_id: string;
  connection_id: string;
  source: string;
  rule_id: string | null;
  rule_name: string | null;
  status: 'open' | 'resolved';
  resolution: ReviewResolution | null;
  created_at: Date;
  resolved_at: Date | null;
  body: string;
  display_name: string | null;
  platform: Platform;
}

const VIEW_SQL = `SELECT i.id, i.comment_id, i.connection_id, i.source, i.rule_id, ru.name AS rule_name, i.status,
         i.resolution, i.created_at, i.resolved_at, c.body, au.display_name, cn.platform
    FROM review_item i
    JOIN comment c ON c.organization_id = i.organization_id AND c.brand_id = i.brand_id AND c.id = i.comment_id
    JOIN connection cn ON cn.organization_id = i.organization_id AND cn.brand_id = i.brand_id AND cn.id = i.connection_id
    LEFT JOIN author au ON au.organization_id = c.organization_id AND au.brand_id = c.brand_id
                       AND au.connection_id = c.connection_id AND au.id = c.author_id
    LEFT JOIN rule ru ON ru.organization_id = i.organization_id AND ru.brand_id = i.brand_id AND ru.id = i.rule_id
   WHERE i.organization_id = $1 AND i.brand_id = $2`;

const toView = (r: ItemDb): ReviewItemView => ({
  id: r.id,
  commentId: r.comment_id,
  connectionId: r.connection_id,
  source: r.source,
  ruleId: r.rule_id,
  ruleName: r.rule_name,
  status: r.status,
  resolution: r.resolution,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  commentBody: r.body,
  authorName: r.display_name,
  platform: r.platform,
});

const CLAIM_TTL_SECONDS = 120;

export class PgReviewQueue {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Returns the comment's open item, creating one if there is none. `created` is also true
   * when the open item is the one this evaluation's own decision opened for this rule (the
   * "flag" decision trigger runs before the step does) and no other step holds it yet: the
   * step then owns that item.
   */
  async open(
    tx: pg.PoolClient,
    scope: ConnectionScope,
    i: { commentId: string; source: 'action_step'; ruleId: string; evaluationId?: string },
  ): Promise<{ id: string; created: boolean }> {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, rule_id)
       SELECT c.organization_id, c.brand_id, c.connection_id, c.id, $5, $6
         FROM comment c
        WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3 AND c.id = $4
       ON CONFLICT (comment_id) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [scope.organizationId, scope.brandId, scope.connectionId, i.commentId, i.source, i.ruleId],
    );
    if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
    const existing = await tx.query<{ id: string; own: boolean }>(
      `SELECT i.id,
              (i.source = 'rule' AND i.rule_id = $5 AND $6::uuid IS NOT NULL
               AND EXISTS (SELECT 1 FROM decision d
                            WHERE d.organization_id = $1 AND d.brand_id = $2 AND d.id = i.decision_id
                              AND d.rule_evaluation_id = $6)
               AND NOT EXISTS (SELECT 1 FROM action_run_step s
                                WHERE s.organization_id = $1 AND s.brand_id = $2
                                  AND s.review_item_id = i.id)) AS own
         FROM review_item i
        WHERE i.organization_id = $1 AND i.brand_id = $2 AND i.connection_id = $3
          AND i.comment_id = $4 AND i.status = 'open'`,
      [
        scope.organizationId,
        scope.brandId,
        scope.connectionId,
        i.commentId,
        i.ruleId,
        i.evaluationId ?? null,
      ],
    );
    if (!existing.rows[0]) throw new Error('comment_not_found');
    return { id: existing.rows[0].id, created: existing.rows[0].own };
  }

  /** Newest first; `before` is the id of the last item of the previous page. */
  async list(
    scope: BrandScope,
    f: { status: 'open' | 'resolved'; before?: string; limit: number },
  ): Promise<ReviewItemView[]> {
    const r = await this.pool.query<ItemDb>(
      `${VIEW_SQL}
        AND i.status = $3
        AND ($4::uuid IS NULL OR (i.created_at, i.id) < (
              SELECT b.created_at, b.id FROM review_item b
               WHERE b.organization_id = $1 AND b.brand_id = $2 AND b.id = $4))
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $5`,
      [scope.organizationId, scope.brandId, f.status, f.before ?? null, clampLimit(f.limit)],
    );
    return r.rows.map(toView);
  }

  async load(scope: BrandScope, id: string): Promise<ReviewItemView | null> {
    const r = await this.pool.query<ItemDb>(`${VIEW_SQL} AND i.id = $3`, [
      scope.organizationId,
      scope.brandId,
      id,
    ]);
    return r.rows[0] ? toView(r.rows[0]) : null;
  }

  /**
   * Holds an open item for the caller's key while its platform action is requested, so two
   * moderators choosing different actions cannot both reach the platform. The same key can
   * claim again, and a claim nobody finished expires. False when the item is resolved,
   * claimed by another key, or not in scope.
   */
  async claim(scope: BrandScope, id: string, key: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE review_item SET claim_key = $4, claimed_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND status = 'open'
          AND (claim_key IS NULL OR claim_key = $4
               OR claimed_at < now() - make_interval(secs => $5))`,
      [scope.organizationId, scope.brandId, id, key, CLAIM_TTL_SECONDS],
    );
    return res.rowCount === 1;
  }

  async release(scope: BrandScope, id: string, key: string): Promise<void> {
    await this.pool.query(
      `UPDATE review_item SET claim_key = NULL, claimed_at = NULL
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND claim_key = $4`,
      [scope.organizationId, scope.brandId, id, key],
    );
  }

  /** Only while open and not claimed by another key; false otherwise or when not in scope. */
  async resolve(
    tx: pg.PoolClient,
    scope: BrandScope,
    id: string,
    r: {
      resolution: ReviewResolution;
      userId: string | null;
      actionId: string | null;
      claimKey?: string;
    },
  ): Promise<boolean> {
    const res = await tx.query(
      `UPDATE review_item
          SET status = 'resolved', resolution = $4, resolved_by_user_id = $5, resolution_action_id = $6,
              resolved_at = now(), claim_key = NULL, claimed_at = NULL
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND status = 'open'
          AND claim_key IS NOT DISTINCT FROM $7::text`,
      [
        scope.organizationId,
        scope.brandId,
        id,
        r.resolution,
        r.userId,
        r.actionId,
        r.claimKey ?? null,
      ],
    );
    return res.rowCount === 1;
  }
}
