// custom_policy rows and their append-only revisions. Editing text or action
// adds a revision; name and enabled live on the policy. Every statement filters
// on organization_id AND brand_id. Writers lock the brand row first (as
// PgRuleStore does), so the per-brand limits cannot be raced past.
import type pg from 'pg';
import { isUniqueViolation } from '@feedbouncer/db';
import type { BrandScope } from '@feedbouncer/rules';
import { normalizePolicyText, policyWarnings } from './text.js';
import {
  MAX_ENABLED_POLICIES_PER_BRAND,
  MAX_POLICIES_PER_BRAND,
  RUN_MIN_INTERVAL_MINUTES,
  type ActivePolicy,
  type PolicyAction,
} from './types.js';

export class PolicyLimitError extends Error {
  constructor(
    readonly limit: 'policies' | 'enabled',
    readonly max: number,
  ) {
    super(limit === 'policies' ? 'policy_limit_reached' : 'enabled_policy_limit_reached');
    this.name = 'PolicyLimitError';
  }
}
export class PolicyNameTakenError extends Error {
  constructor() {
    super('policy_name_taken');
    this.name = 'PolicyNameTakenError';
  }
}

export interface StoredPolicy {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  revisionId: string;
  revision: number;
  text: string;
  action: PolicyAction;
  vague: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export interface StoredRevision {
  id: string;
  revision: number;
  text: string;
  action: PolicyAction;
  vague: boolean;
  createdAt: Date;
  createdByUserId: string | null;
}
export interface PolicyCreate {
  name: string;
  text: string;
  action: PolicyAction;
}
export interface PolicyUpdate {
  name?: string;
  text?: string;
  action?: PolicyAction;
  enabled?: boolean;
}

type Queryable = Pick<pg.ClientBase, 'query'>;

const NAME_KEY = 'custom_policy_brand_id_name_key';

const CURRENT = `
  SELECT p.id, p.name, p.enabled, (p.archived_at IS NOT NULL) AS archived, p.created_at, p.updated_at,
         r.id AS revision_id, r.revision, r.text, r.action, r.vague
    FROM custom_policy p
    JOIN LATERAL (
      SELECT id, revision, text, action, vague FROM custom_policy_revision
       WHERE organization_id = p.organization_id AND brand_id = p.brand_id AND policy_id = p.id
       ORDER BY revision DESC LIMIT 1
    ) r ON true`;

interface PolicyRow {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  revision_id: string;
  revision: number;
  text: string;
  action: PolicyAction;
  vague: boolean;
}
const toPolicy = (r: PolicyRow): StoredPolicy => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  archived: r.archived,
  revisionId: r.revision_id,
  revision: r.revision,
  text: r.text,
  action: r.action,
  vague: r.vague,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toActive = (r: PolicyRow): ActivePolicy => ({
  policyId: r.id,
  revisionId: r.revision_id,
  revision: r.revision,
  name: r.name,
  text: r.text,
  action: r.action,
});

function mapNameTaken(err: unknown): never {
  if (isUniqueViolation(err, NAME_KEY)) throw new PolicyNameTakenError();
  throw err;
}

export class PgPolicyStore {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  /** Non-archived policies with their current revision, in creation order. */
  async list(s: BrandScope, q: Queryable = this.#pool): Promise<StoredPolicy[]> {
    const { rows } = await q.query<PolicyRow>(
      `${CURRENT}
        WHERE p.organization_id = $1 AND p.brand_id = $2 AND p.archived_at IS NULL
        ORDER BY p.created_at, p.id`,
      [s.organizationId, s.brandId],
    );
    return rows.map(toPolicy);
  }

  async get(
    s: BrandScope,
    policyId: string,
    q: Queryable = this.#pool,
  ): Promise<StoredPolicy | null> {
    const { rows } = await q.query<PolicyRow>(
      `${CURRENT}
        WHERE p.organization_id = $1 AND p.brand_id = $2 AND p.archived_at IS NULL AND p.id = $3`,
      [s.organizationId, s.brandId, policyId],
    );
    return rows[0] ? toPolicy(rows[0]) : null;
  }

  /** Every revision of a policy (archived ones too), newest first. */
  async revisions(
    s: BrandScope,
    policyId: string,
    q: Queryable = this.#pool,
  ): Promise<StoredRevision[]> {
    const { rows } = await q.query<{
      id: string;
      revision: number;
      text: string;
      action: PolicyAction;
      vague: boolean;
      created_at: Date;
      created_by_user_id: string | null;
    }>(
      `SELECT id, revision, text, action, vague, created_at, created_by_user_id
         FROM custom_policy_revision
        WHERE organization_id = $1 AND brand_id = $2 AND policy_id = $3
        ORDER BY revision DESC`,
      [s.organizationId, s.brandId, policyId],
    );
    return rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      text: r.text,
      action: r.action,
      vague: r.vague,
      createdAt: r.created_at,
      createdByUserId: r.created_by_user_id,
    }));
  }

  /** Creates a disabled policy with revision 1. Runs inside the caller's transaction. */
  async create(
    c: pg.PoolClient,
    s: BrandScope,
    input: PolicyCreate,
    userId: string | null,
  ): Promise<StoredPolicy> {
    if (!(await this.#lockBrand(c, s))) throw new TypeError('brand_not_found');
    const { rows: counted } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM custom_policy
        WHERE organization_id = $1 AND brand_id = $2 AND archived_at IS NULL`,
      [s.organizationId, s.brandId],
    );
    if ((counted[0]?.n ?? 0) >= MAX_POLICIES_PER_BRAND)
      throw new PolicyLimitError('policies', MAX_POLICIES_PER_BRAND);
    // A name clash aborts the caller's transaction; the caller maps the error and rolls back.
    const { rows } = await c
      .query<{ id: string }>(
        `INSERT INTO custom_policy (organization_id, brand_id, name, created_by_user_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [s.organizationId, s.brandId, input.name, userId],
      )
      .catch(mapNameTaken);
    const id = rows[0]!.id;
    const text = normalizePolicyText(input.text);
    await this.#insertRevision(c, s, id, 1, text, input.action, userId);
    return (await this.get(s, id, c))!;
  }

  /**
   * Applies a patch. A changed text or action adds a revision; name and enabled
   * change the policy row only. Null when the policy is missing or archived.
   */
  async update(
    c: pg.PoolClient,
    s: BrandScope,
    policyId: string,
    patch: PolicyUpdate,
    userId: string | null,
  ): Promise<{
    policy: StoredPolicy;
    revised: boolean;
    renamed: boolean;
    enabledChanged: boolean;
  } | null> {
    if (!(await this.#lockBrand(c, s))) return null;
    const { rows: locked } = await c.query<{ enabled: boolean; name: string }>(
      `SELECT enabled, name FROM custom_policy
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND archived_at IS NULL
          FOR UPDATE`,
      [s.organizationId, s.brandId, policyId],
    );
    const row = locked[0];
    if (!row) return null;
    const enabledChanged = patch.enabled !== undefined && patch.enabled !== row.enabled;
    const renamed = patch.name !== undefined && patch.name !== row.name;
    if (patch.enabled === true && enabledChanged) {
      const { rows: counted } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM custom_policy
          WHERE organization_id = $1 AND brand_id = $2 AND enabled`,
        [s.organizationId, s.brandId],
      );
      if ((counted[0]?.n ?? 0) >= MAX_ENABLED_POLICIES_PER_BRAND)
        throw new PolicyLimitError('enabled', MAX_ENABLED_POLICIES_PER_BRAND);
    }
    const cur = (await this.get(s, policyId, c))!;
    const nextText = patch.text === undefined ? cur.text : normalizePolicyText(patch.text);
    const nextAction = patch.action ?? cur.action;
    const revised = nextText !== cur.text || nextAction !== cur.action;
    if (revised)
      await this.#insertRevision(c, s, policyId, cur.revision + 1, nextText, nextAction, userId);
    if (revised || patch.name !== undefined || patch.enabled !== undefined) {
      // Touches updated_at on a revision too, so the list shows the latest edit time.
      await c
        .query(
          `UPDATE custom_policy SET name = COALESCE($4, name), enabled = COALESCE($5, enabled)
            WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND archived_at IS NULL`,
          [s.organizationId, s.brandId, policyId, patch.name ?? null, patch.enabled ?? null],
        )
        .catch(mapNameTaken);
    }
    return { policy: (await this.get(s, policyId, c))!, revised, renamed, enabledChanged };
  }

  /** Delete is archive: the policy is disabled and hidden; revisions and decisions stay. */
  async archive(c: pg.PoolClient, s: BrandScope, policyId: string): Promise<boolean> {
    if (!(await this.#lockBrand(c, s))) return false;
    const { rows } = await c.query(
      `UPDATE custom_policy SET enabled = false, archived_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND archived_at IS NULL
        RETURNING id`,
      [s.organizationId, s.brandId, policyId],
    );
    return rows.length > 0;
  }

  async hasEnabled(s: BrandScope, q: Queryable = this.#pool): Promise<boolean> {
    const { rows } = await q.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM custom_policy
                       WHERE organization_id = $1 AND brand_id = $2 AND enabled) AS ok`,
      [s.organizationId, s.brandId],
    );
    return rows[0]?.ok ?? false;
  }

  /** Enabled policies at their current revision, ordered by (created_at, id): decidePolicies relies on it. */
  async enabledForEvaluation(s: BrandScope, q: Queryable = this.#pool): Promise<ActivePolicy[]> {
    const { rows } = await q.query<PolicyRow>(
      `${CURRENT}
        WHERE p.organization_id = $1 AND p.brand_id = $2 AND p.archived_at IS NULL AND p.enabled
        ORDER BY p.created_at, p.id
        LIMIT ${MAX_ENABLED_POLICIES_PER_BRAND}`,
      [s.organizationId, s.brandId],
    );
    return rows.map(toActive);
  }

  /**
   * The policy revision a run was requested for, or null when that revision is
   * no longer current or the policy is disabled or archived.
   */
  async forRun(
    s: BrandScope,
    runId: string,
    q: Queryable = this.#pool,
  ): Promise<ActivePolicy | null> {
    const { rows } = await q.query<PolicyRow>(
      `SELECT p.id, p.name, p.enabled, (p.archived_at IS NOT NULL) AS archived, p.created_at, p.updated_at,
              r.id AS revision_id, r.revision, r.text, r.action, r.vague
         FROM policy_run pr
         JOIN custom_policy p
           ON p.organization_id = pr.organization_id AND p.brand_id = pr.brand_id AND p.id = pr.policy_id
         JOIN custom_policy_revision r
           ON r.organization_id = pr.organization_id AND r.brand_id = pr.brand_id AND r.id = pr.revision_id
        WHERE pr.organization_id = $1 AND pr.brand_id = $2 AND pr.id = $3
          AND p.enabled AND p.archived_at IS NULL
          AND r.revision = (SELECT max(revision) FROM custom_policy_revision
                             WHERE organization_id = p.organization_id AND brand_id = p.brand_id
                               AND policy_id = p.id)`,
      [s.organizationId, s.brandId, runId],
    );
    return rows[0] ? toActive(rows[0]) : null;
  }

  /**
   * Records an explicit apply-to-recent-comments request for one policy revision.
   * 'too_soon' when the brand already started a run within the minimum interval.
   */
  async insertRun(
    c: pg.PoolClient,
    s: BrandScope,
    r: { policyId: string; revisionId: string; days: number; userId: string | null },
  ): Promise<{ id: string } | 'too_soon'> {
    if (!(await this.#lockBrand(c, s))) throw new TypeError('brand_not_found');
    const { rowCount } = await c.query(
      `SELECT 1 FROM policy_run
        WHERE organization_id = $1 AND brand_id = $2
          AND created_at > now() - make_interval(mins => $3)`,
      [s.organizationId, s.brandId, RUN_MIN_INTERVAL_MINUTES],
    );
    if ((rowCount ?? 0) > 0) return 'too_soon';
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO policy_run (organization_id, brand_id, policy_id, revision_id, days, since, requested_by_user_id)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $5), $6) RETURNING id`,
      [s.organizationId, s.brandId, r.policyId, r.revisionId, r.days, r.userId],
    );
    return { id: rows[0]!.id };
  }

  /** The cutoff of a run, or null when it was withdrawn. */
  async loadRun(s: BrandScope, runId: string): Promise<{ since: Date } | null> {
    const { rows } = await this.#pool.query<{ since: Date }>(
      `SELECT since FROM policy_run WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      [s.organizationId, s.brandId, runId],
    );
    return rows[0] ?? null;
  }

  /** Removes a run whose jobs could not be enqueued, so it does not hold the interval. */
  async withdrawRun(s: BrandScope, runId: string): Promise<void> {
    await this.#pool.query(
      `DELETE FROM policy_run WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      [s.organizationId, s.brandId, runId],
    );
  }

  /** The brand's connections that can currently receive jobs. */
  async activeConnections(
    s: BrandScope,
    q: Queryable = this.#pool,
  ): Promise<{ connectionId: string; platform: string }[]> {
    const { rows } = await q.query<{ id: string; platform: string }>(
      `SELECT id, platform FROM connection
        WHERE organization_id = $1 AND brand_id = $2 AND status = 'active' ORDER BY id`,
      [s.organizationId, s.brandId],
    );
    return rows.map((r) => ({ connectionId: r.id, platform: r.platform }));
  }

  async #lockBrand(c: pg.PoolClient, s: BrandScope): Promise<boolean> {
    const { rowCount } = await c.query(
      `SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [s.organizationId, s.brandId],
    );
    return (rowCount ?? 0) > 0;
  }

  async #insertRevision(
    c: pg.PoolClient,
    s: BrandScope,
    policyId: string,
    revision: number,
    text: string,
    action: PolicyAction,
    userId: string | null,
  ): Promise<void> {
    const vague = policyWarnings(text).length > 0;
    await c.query(
      `INSERT INTO custom_policy_revision
         (organization_id, brand_id, policy_id, revision, text, action, vague, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [s.organizationId, s.brandId, policyId, revision, text, action, vague, userId],
    );
  }
}
