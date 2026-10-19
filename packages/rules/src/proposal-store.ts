import type pg from 'pg';

export type ProposalOperation = 'create' | 'update' | 'archive';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'stale';

export interface NewProposal {
  organizationId: string;
  brandId: string;
  operation: ProposalOperation;
  targetRuleId: string | null;
  /** RuleSnapshot; null for create. */
  before: unknown;
  /** RuleSnapshot; null for archive. */
  after: unknown;
  /** ruleDiff() output. */
  diff: unknown;
  warnings: string[];
  rationale: string | null;
  baseRuleRevision: number;
  proposedByApiKeyId: string;
  requestKey: string;
  /** Hours from now (database clock) until the proposal expires. */
  ttlHours: number;
}

export interface ProposalRow extends Omit<NewProposal, 'ttlHours'> {
  id: string;
  /** As stored; read it through effectiveStatus(). */
  status: ProposalStatus;
  expiresAt: Date;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedRuleId: string | null;
  createdAt: Date;
}

/** Expiry is lazy: a pending proposal past expires_at reads as expired, with no sweep job. */
export const effectiveStatus = (
  row: Pick<ProposalRow, 'status' | 'expiresAt'>,
  now: Date = new Date(),
): ProposalStatus => (row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status);

export class ProposalNotPendingError extends Error {
  constructor() {
    super('proposal_not_pending');
    this.name = 'ProposalNotPendingError';
  }
}

const EFFECTIVE_STATUS_SQL = `CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END`;
const LIVE_PENDING_SQL = `status = 'pending' AND expires_at > now()`;

const COLS = `id, organization_id, brand_id, operation, target_rule_id, before, after, diff, warnings,
  rationale, base_rule_revision, proposed_by_api_key_id, request_key,
  status, expires_at, decided_by_user_id, decided_at, decision_note, applied_rule_id, created_at`;

interface Row {
  id: string;
  organization_id: string;
  brand_id: string;
  operation: ProposalOperation;
  target_rule_id: string | null;
  before: unknown;
  after: unknown;
  diff: unknown;
  warnings: string[];
  rationale: string | null;
  /** bigint, returned as text by pg. */
  base_rule_revision: string;
  proposed_by_api_key_id: string;
  request_key: string;
  status: ProposalStatus;
  expires_at: Date;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  applied_rule_id: string | null;
  created_at: Date;
}

const toProposal = (r: Row): ProposalRow => ({
  id: r.id,
  organizationId: r.organization_id,
  brandId: r.brand_id,
  operation: r.operation,
  targetRuleId: r.target_rule_id,
  before: r.before,
  after: r.after,
  diff: r.diff,
  warnings: r.warnings,
  rationale: r.rationale,
  baseRuleRevision: Number(r.base_rule_revision),
  proposedByApiKeyId: r.proposed_by_api_key_id,
  requestKey: r.request_key,
  status: r.status,
  expiresAt: r.expires_at,
  decidedByUserId: r.decided_by_user_id,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  appliedRuleId: r.applied_rule_id,
  createdAt: r.created_at,
});

const json = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));

/**
 * Rule-change proposals. Reads filter on organization_id; the brand-keyed methods run
 * inside a transaction that has already resolved the brand within the caller's organization.
 */
export class PgRuleProposalStore {
  async create(tx: pg.ClientBase, p: NewProposal): Promise<ProposalRow> {
    const { rows } = await tx.query<Row>(
      `INSERT INTO rule_change_proposal
         (organization_id, brand_id, operation, target_rule_id, before, after, diff, warnings,
          rationale, base_rule_revision, proposed_by_api_key_id, request_key, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12,
               now() + make_interval(hours => $13))
       RETURNING ${COLS}`,
      [
        p.organizationId,
        p.brandId,
        p.operation,
        p.targetRuleId,
        json(p.before),
        json(p.after),
        JSON.stringify(p.diff),
        JSON.stringify(p.warnings),
        p.rationale,
        p.baseRuleRevision,
        p.proposedByApiKeyId,
        p.requestKey,
        p.ttlHours,
      ],
    );
    return toProposal(rows[0]!);
  }

  /** A live pending proposal of the same change on the same base revision. */
  async findPendingDuplicate(
    tx: pg.ClientBase,
    brandId: string,
    operation: ProposalOperation,
    targetRuleId: string | null,
    after: unknown,
    baseRevision: number,
  ): Promise<ProposalRow | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${COLS} FROM rule_change_proposal
        WHERE brand_id = $1 AND ${LIVE_PENDING_SQL} AND operation = $2
          AND target_rule_id IS NOT DISTINCT FROM $3 AND after IS NOT DISTINCT FROM $4::jsonb
          AND base_rule_revision = $5
        ORDER BY created_at, id LIMIT 1`,
      [brandId, operation, targetRuleId, json(after), baseRevision],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }

  async countPending(tx: pg.ClientBase, brandId: string): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rule_change_proposal WHERE brand_id = $1 AND ${LIVE_PENDING_SQL}`,
      [brandId],
    );
    return rows[0]!.n;
  }

  async get(
    db: pg.Pool | pg.ClientBase,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<ProposalRow | null> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLS} FROM rule_change_proposal WHERE organization_id = $1 AND id = $2
        ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [orgId, id],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }

  /**
   * Newest first. `statuses` matches the effective status; `since` keeps pending proposals
   * and those settled (decided, or expired unattended) at or after it.
   */
  async list(
    db: pg.Pool | pg.ClientBase,
    orgId: string,
    brandId: string,
    opts: { statuses?: ProposalStatus[]; since?: Date },
  ): Promise<ProposalRow[]> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLS} FROM rule_change_proposal
        WHERE organization_id = $1 AND brand_id = $2
          AND ($3::text[] IS NULL OR ${EFFECTIVE_STATUS_SQL} = ANY($3))
          AND ($4::timestamptz IS NULL OR ${LIVE_PENDING_SQL}
               OR coalesce(decided_at, expires_at) >= $4)
        ORDER BY created_at DESC, id DESC`,
      [orgId, brandId, opts.statuses ?? null, opts.since ?? null],
    );
    return rows.map(toProposal);
  }

  /**
   * Settles a pending proposal of the organization; the caller holds it FOR UPDATE (see get).
   * Throws ProposalNotPendingError when there is no such pending proposal.
   */
  async decide(
    tx: pg.ClientBase,
    orgId: string,
    id: string,
    patch: {
      status: Exclude<ProposalStatus, 'pending'>;
      decidedByUserId?: string;
      decisionNote?: string;
      appliedRuleId?: string;
    },
  ): Promise<void> {
    const { rowCount } = await tx.query(
      `UPDATE rule_change_proposal
          SET status = $3, decided_by_user_id = $4, decided_at = now(), decision_note = $5,
              applied_rule_id = $6
        WHERE organization_id = $1 AND id = $2 AND status = 'pending'`,
      [
        orgId,
        id,
        patch.status,
        patch.decidedByUserId ?? null,
        patch.decisionNote ?? null,
        patch.appliedRuleId ?? null,
      ],
    );
    if (rowCount !== 1) throw new ProposalNotPendingError();
  }
}
