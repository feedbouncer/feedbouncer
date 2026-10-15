import type pg from 'pg';
import type { BrandScope } from '@feedbouncer/comments';
import {
  checkActionForConditions,
  ruleConditionsSchema,
  type RuleInput,
  type RulePatch,
} from './conditions.js';
import { ruleOrder } from './engine.js';
import type { RuleAction, RuleKind, RuleMode, RuleRecord } from './types.js';

export type { BrandScope };

export interface StoredRule {
  id: string;
  name: string;
  kind: RuleKind | null;
  conditions: unknown;
  action: RuleAction;
  mode: RuleMode;
  enabled: boolean;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface BrandDomain {
  id: string;
  domain: string;
  createdAt: Date;
}

export const MAX_RULES_PER_BRAND = 200;
export const MAX_DOMAINS_PER_BRAND = 50;
export class RuleLimitError extends Error {
  constructor() {
    super('rule_limit_reached');
    this.name = 'RuleLimitError';
  }
}
export class InvalidRuleConditionsError extends Error {
  constructor() {
    super('invalid_conditions');
    this.name = 'InvalidRuleConditionsError';
  }
}
export class InvalidRuleActionError extends Error {
  constructor() {
    super('invalid_action_for_conditions');
    this.name = 'InvalidRuleActionError';
  }
}
export class DomainLimitError extends Error {
  constructor() {
    super('domain_limit_reached');
    this.name = 'DomainLimitError';
  }
}

const COLS = `id, name, kind, conditions, action, mode, enabled, priority, created_at, updated_at`;
const ORDER = `ORDER BY priority, created_at, id`;

/** Per-brand revision counter, bumped by database triggers on every rule and own-domain write. */
const VERSION_SQL = `SELECT rule_revision::text AS v FROM brand WHERE organization_id = $1 AND id = $2`;
const NO_BRAND_VERSION = '-';

const isPinned = (conditions: unknown): boolean => {
  const c = conditions as { type?: unknown; list?: unknown } | null;
  return c?.type === 'author' && c.list === 'trusted';
};
/** Engine evaluation order; engine.ruleOrder is the single source of truth. */
function inEngineOrder<
  T extends { id: string; priority: number; conditions: unknown } & (
    | { createdAt: Date }
    | { created_at: Date }
  ),
>(rows: T[]): T[] {
  const key = (r: T) => ({
    id: r.id,
    priority: r.priority,
    createdAt: 'createdAt' in r ? r.createdAt : r.created_at,
    pinned: isPinned(r.conditions),
  });
  return [...rows].sort((a, b) => ruleOrder(key(a), key(b)));
}

interface RuleRow {
  id: string;
  name: string;
  kind: RuleKind | null;
  conditions: unknown;
  action: RuleAction;
  mode: RuleMode;
  enabled: boolean;
  priority: number;
  created_at: Date;
  updated_at: Date;
}
const toRule = (r: RuleRow): StoredRule => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  conditions: r.conditions,
  action: r.action,
  mode: r.mode,
  enabled: r.enabled,
  priority: r.priority,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Rules and own-domain storage. Every statement filters on organization_id AND
 * brand_id. Write methods run inside the caller's transaction so audit rows can
 * share it; limit checks lock the brand row so concurrent writers serialise.
 * Errors never carry rule terms.
 */
export class PgRuleStore {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async list(scope: BrandScope): Promise<StoredRule[]> {
    const { rows } = await this.#pool.query<RuleRow>(
      `SELECT ${COLS} FROM rule
        WHERE organization_id = $1 AND brand_id = $2 AND archived_at IS NULL ${ORDER}`,
      [scope.organizationId, scope.brandId],
    );
    return inEngineOrder(rows.map(toRule));
  }

  async get(scope: BrandScope, ruleId: string): Promise<StoredRule | null> {
    const { rows } = await this.#pool.query<RuleRow>(
      `SELECT ${COLS} FROM rule
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND archived_at IS NULL`,
      [scope.organizationId, scope.brandId, ruleId],
    );
    return rows[0] ? toRule(rows[0]) : null;
  }

  async #lockBrand(tx: pg.PoolClient, scope: BrandScope): Promise<boolean> {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [scope.organizationId, scope.brandId],
    );
    return (rowCount ?? 0) > 0;
  }

  async create(tx: pg.PoolClient, scope: BrandScope, input: RuleInput): Promise<StoredRule> {
    if (!(await this.#lockBrand(tx, scope))) throw new TypeError('brand_not_found');
    const { rows: counted } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rule
        WHERE organization_id = $1 AND brand_id = $2 AND archived_at IS NULL`,
      [scope.organizationId, scope.brandId],
    );
    if ((counted[0]?.n ?? 0) >= MAX_RULES_PER_BRAND) throw new RuleLimitError();
    const { rows } = await tx.query<RuleRow>(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action, mode, enabled, priority)
       SELECT $1, $2, $3, $4::jsonb, $5, $6, $7,
              COALESCE((SELECT max(priority) FROM rule
                         WHERE organization_id = $1 AND brand_id = $2 AND archived_at IS NULL), 0) + 10
       RETURNING ${COLS}`,
      [
        scope.organizationId,
        scope.brandId,
        input.name,
        JSON.stringify(input.conditions),
        input.action,
        input.mode,
        input.enabled,
      ],
    );
    return toRule(rows[0]!);
  }

  async update(
    tx: pg.PoolClient,
    scope: BrandScope,
    ruleId: string,
    patch: RulePatch,
  ): Promise<StoredRule | null> {
    // Brand first, like every other writer, so concurrent writes cannot deadlock on the revision bump.
    if (!(await this.#lockBrand(tx, scope))) return null;
    const { rows: cur } = await tx.query<RuleRow>(
      `SELECT ${COLS} FROM rule
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND archived_at IS NULL
          FOR UPDATE`,
      [scope.organizationId, scope.brandId, ruleId],
    );
    const row = cur[0];
    if (!row) return null;
    const merged = {
      name: patch.name ?? row.name,
      conditions: patch.conditions ?? row.conditions,
      action: patch.action ?? row.action,
      mode: patch.mode ?? row.mode,
      enabled: patch.enabled ?? row.enabled,
    };
    const parsed = ruleConditionsSchema.safeParse(merged.conditions);
    if (!parsed.success) throw new InvalidRuleConditionsError();
    if (checkActionForConditions(parsed.data, merged.action) !== null)
      throw new InvalidRuleActionError();
    const { rows } = await tx.query<RuleRow>(
      `UPDATE rule SET name = $4, conditions = $5::jsonb, action = $6, mode = $7, enabled = $8
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND archived_at IS NULL
        RETURNING ${COLS}`,
      [
        scope.organizationId,
        scope.brandId,
        ruleId,
        merged.name,
        JSON.stringify(parsed.data),
        merged.action,
        merged.mode,
        merged.enabled,
      ],
    );
    return rows[0] ? toRule(rows[0]) : null;
  }

  /** Delete is archive: decisions keep citing the rule. */
  async archive(tx: pg.PoolClient, scope: BrandScope, ruleId: string): Promise<boolean> {
    if (!(await this.#lockBrand(tx, scope))) return false;
    const { rowCount } = await tx.query(
      `UPDATE rule SET archived_at = now(), enabled = false
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND archived_at IS NULL`,
      [scope.organizationId, scope.brandId, ruleId],
    );
    return (rowCount ?? 0) > 0;
  }

  async reorder(
    tx: pg.PoolClient,
    scope: BrandScope,
    ruleIds: string[],
  ): Promise<'ok' | 'mismatch'> {
    if (!(await this.#lockBrand(tx, scope))) return 'mismatch';
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM rule
        WHERE organization_id = $1 AND brand_id = $2 AND archived_at IS NULL FOR UPDATE`,
      [scope.organizationId, scope.brandId],
    );
    const existing = new Set(rows.map((r) => r.id));
    const given = new Set(ruleIds);
    if (
      given.size !== ruleIds.length ||
      given.size !== existing.size ||
      ruleIds.some((id) => !existing.has(id))
    )
      return 'mismatch';
    if (ruleIds.length === 0) return 'ok';
    await tx.query(
      `UPDATE rule r SET priority = o.pos * 10
         FROM unnest($3::uuid[]) WITH ORDINALITY AS o(id, pos)
        WHERE r.organization_id = $1 AND r.brand_id = $2 AND r.id = o.id AND r.archived_at IS NULL`,
      [scope.organizationId, scope.brandId, ruleIds],
    );
    return 'ok';
  }

  async listDomains(scope: BrandScope): Promise<BrandDomain[]> {
    const { rows } = await this.#pool.query<{ id: string; domain: string; created_at: Date }>(
      `SELECT id, domain, created_at FROM brand_domain
        WHERE organization_id = $1 AND brand_id = $2 ORDER BY domain`,
      [scope.organizationId, scope.brandId],
    );
    return rows.map((r) => ({ id: r.id, domain: r.domain, createdAt: r.created_at }));
  }

  async addDomain(
    tx: pg.PoolClient,
    scope: BrandScope,
    asciiDomain: string,
  ): Promise<BrandDomain | 'exists'> {
    if (!(await this.#lockBrand(tx, scope))) throw new TypeError('brand_not_found');
    const dup = await tx.query(
      `SELECT 1 FROM brand_domain WHERE organization_id = $1 AND brand_id = $2 AND domain = $3`,
      [scope.organizationId, scope.brandId, asciiDomain],
    );
    if ((dup.rowCount ?? 0) > 0) return 'exists';
    const { rows: counted } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM brand_domain WHERE organization_id = $1 AND brand_id = $2`,
      [scope.organizationId, scope.brandId],
    );
    if ((counted[0]?.n ?? 0) >= MAX_DOMAINS_PER_BRAND) throw new DomainLimitError();
    const { rows } = await tx.query<{ id: string; domain: string; created_at: Date }>(
      `INSERT INTO brand_domain (organization_id, brand_id, domain) VALUES ($1, $2, $3)
       ON CONFLICT (brand_id, domain) DO NOTHING
       RETURNING id, domain, created_at`,
      [scope.organizationId, scope.brandId, asciiDomain],
    );
    const r = rows[0];
    return r ? { id: r.id, domain: r.domain, createdAt: r.created_at } : 'exists';
  }

  async removeDomain(
    tx: pg.PoolClient,
    scope: BrandScope,
    domainId: string,
  ): Promise<BrandDomain | null> {
    if (!(await this.#lockBrand(tx, scope))) return null;
    const { rows } = await tx.query<{ id: string; domain: string; created_at: Date }>(
      `DELETE FROM brand_domain WHERE organization_id = $1 AND brand_id = $2 AND id = $3
       RETURNING id, domain, created_at`,
      [scope.organizationId, scope.brandId, domainId],
    );
    const r = rows[0];
    return r ? { id: r.id, domain: r.domain, createdAt: r.created_at } : null;
  }

  /** Changes whenever the brand's rules or own domains are written. */
  async version(scope: BrandScope): Promise<string> {
    const { rows } = await this.#pool.query<{ v: string }>(VERSION_SQL, [
      scope.organizationId,
      scope.brandId,
    ]);
    return rows[0]?.v ?? NO_BRAND_VERSION;
  }

  async loadActive(
    scope: BrandScope,
  ): Promise<{ version: string; records: RuleRecord[]; ownDomains: string[] }> {
    // One snapshot so the version matches the data it labels.
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const q = <T extends pg.QueryResultRow>(sql: string) =>
        c.query<T>(sql, [scope.organizationId, scope.brandId]);
      const v = await q<{ v: string }>(VERSION_SQL);
      const rules = await q<RuleRow>(
        `SELECT ${COLS} FROM rule
          WHERE organization_id = $1 AND brand_id = $2 AND archived_at IS NULL AND enabled ${ORDER}`,
      );
      const doms = await q<{ domain: string }>(
        `SELECT domain FROM brand_domain WHERE organization_id = $1 AND brand_id = $2 ORDER BY domain`,
      );
      await c.query('COMMIT');
      return {
        version: v.rows[0]?.v ?? NO_BRAND_VERSION,
        records: inEngineOrder(rules.rows).map((r) => ({
          id: r.id,
          name: r.name,
          conditions: r.conditions,
          action: r.action,
          mode: r.mode,
          priority: r.priority,
          enabled: r.enabled,
          createdAt: r.created_at,
        })),
        ownDomains: doms.rows.map((d) => d.domain),
      };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}
