import type pg from 'pg';
import type { BrandScope, RuleAction } from '@feedbouncer/rules';
import { resolvePolicy } from './defaults.js';
import type { ThresholdItem } from './settings.js';
import { CATEGORIES, type Category, type ThresholdPolicy } from './types.js';

export interface ThresholdView {
  category: Category;
  threshold: number;
  action: RuleAction;
  source: 'default' | 'brand';
  updatedAt: Date | null;
  updatedByUserId: string | null;
}
export interface ThresholdChange {
  category: Category;
  before: { threshold: number; action: RuleAction } | null;
  after: { threshold: number; action: RuleAction } | null;
}
interface Row {
  category: Category;
  threshold: string;
  action: RuleAction;
  updated_at: Date;
  updated_by_user_id: string | null;
}

const SELECT = `SELECT category, threshold::text AS threshold, action, updated_at, updated_by_user_id
                FROM classifier_threshold WHERE organization_id = $1 AND brand_id = $2`;

const toOverrides = (rows: readonly Row[]) =>
  rows.map((x) => ({ category: x.category, threshold: Number(x.threshold), action: x.action }));

export class PgThresholdStore {
  constructor(private readonly pool: pg.Pool) {}

  async policy(s: BrandScope): Promise<ThresholdPolicy> {
    const r = await this.pool.query<Row>(SELECT, [s.organizationId, s.brandId]);
    return resolvePolicy(toOverrides(r.rows));
  }

  async list(s: BrandScope): Promise<ThresholdView[]> {
    const r = await this.pool.query<Row>(SELECT, [s.organizationId, s.brandId]);
    const byCat = new Map(r.rows.map((x) => [x.category, x]));
    const policy = resolvePolicy(toOverrides(r.rows));
    return CATEGORIES.map((c) => ({
      category: c,
      threshold: policy[c].threshold,
      action: policy[c].action,
      source: policy[c].source,
      updatedAt: byCat.get(c)?.updated_at ?? null,
      updatedByUserId: byCat.get(c)?.updated_by_user_id ?? null,
    }));
  }

  /** Runs inside the caller's transaction so audit rows commit with it. */
  async apply(
    c: pg.PoolClient,
    s: BrandScope,
    items: readonly ThresholdItem[],
    userId: string,
  ): Promise<ThresholdChange[]> {
    const lock = await c.query(
      'SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [s.organizationId, s.brandId],
    );
    if (lock.rowCount === 0) throw new Error('brand not found');
    const cur = await c.query<Row>(`${SELECT} FOR UPDATE`, [s.organizationId, s.brandId]);
    const before = new Map(
      cur.rows.map((x) => [x.category, { threshold: Number(x.threshold), action: x.action }]),
    );
    const changes: ThresholdChange[] = [];
    for (const it of items) {
      const prev = before.get(it.category) ?? null;
      if ('useDefault' in it) {
        if (prev === null) continue;
        await c.query(
          `DELETE FROM classifier_threshold WHERE organization_id = $1 AND brand_id = $2 AND category = $3`,
          [s.organizationId, s.brandId, it.category],
        );
        changes.push({ category: it.category, before: prev, after: null });
        continue;
      }
      if (prev && prev.threshold === it.threshold && prev.action === it.action) continue;
      await c.query(
        `INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (brand_id, category) DO UPDATE SET threshold = EXCLUDED.threshold, action = EXCLUDED.action,
           updated_by_user_id = EXCLUDED.updated_by_user_id`,
        [s.organizationId, s.brandId, it.category, it.threshold, it.action, userId],
      );
      changes.push({
        category: it.category,
        before: prev,
        after: { threshold: it.threshold, action: it.action },
      });
    }
    return changes;
  }
}
