import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { can } from '@feedbouncer/authz';
import { withTransaction } from '@feedbouncer/db';
import {
  PgRuleProposalStore,
  PgRuleStore,
  ProposalNotPendingError,
  effectiveStatus,
  ruleDiff,
  validateRuleProposal,
  type ProposalRow,
  type ProposalStatus,
  type RuleProposalInput,
  type RuleSnapshot,
} from '@feedbouncer/rules';
import { recordAudit, type AuditInput } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { RulesService } from '../rules/rules.service.js';
import { requireBrand, type BrandScope } from '../tenancy/brand-scope.js';
import { lockedActor } from '../tenancy/org-lock.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';

export interface RuleChangeView {
  id: string;
  operation: ProposalRow['operation'];
  /** The rule changed, or the rule an approved create made. */
  ruleId: string | null;
  status: ProposalStatus;
  before: unknown;
  after: unknown;
  diff: unknown;
  warnings: string[];
  rationale: string | null;
  expiresAt: string;
  baseRuleRevision: number;
  currentRuleRevision: number;
  /** Pending, but the brand's rules changed since it was proposed (or already settled as stale). */
  isStale: boolean;
  proposedBy: { apiKeyName: string };
  decidedBy: { userId: string; name: string | null } | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

type AuditDetails = NonNullable<AuditInput['details']>;

/** A refusal whose state change must commit before the request fails. */
type Settled = { refused: 'proposal_expired' | 'proposal_stale' };

const asInput = (p: ProposalRow): RuleProposalInput => {
  if (p.operation === 'create') return { operation: 'create', rule: p.after };
  if (p.operation === 'archive') return { operation: 'archive', ruleId: p.targetRuleId! };
  return { operation: 'update', ruleId: p.targetRuleId!, patch: p.after };
};

/** Rule changes proposed through the public API, decided by a person in the dashboard. */
@Injectable()
export class RuleChangesService {
  readonly #proposals = new PgRuleProposalStore();
  readonly #rules: PgRuleStore;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(RulesService) private readonly rulesService: RulesService,
  ) {
    this.#rules = new PgRuleStore(deps.pool);
  }

  async list(
    org: OrgContext,
    brandId: unknown,
    status: ProposalStatus | undefined,
  ): Promise<RuleChangeView[]> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const rows = await this.#proposals.list(this.deps.pool, scope.organizationId, scope.brandId, {
      ...(status && { statuses: [status] }),
    });
    return this.#views(this.deps.pool, scope, rows);
  }

  async get(org: OrgContext, brandId: unknown, id: string): Promise<RuleChangeView> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const row = await this.#proposals.get(this.deps.pool, scope.organizationId, id);
    if (row?.brandId !== scope.brandId) throw notFound();
    return (await this.#views(this.deps.pool, scope, [row]))[0]!;
  }

  async approve(
    org: OrgContext,
    brandId: unknown,
    id: string,
    note: string | undefined,
  ): Promise<RuleChangeView> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const userId = org.actorUserId;
    const settled = await this.#decide(org, scope, id, async (tx, p) => {
      const audit = (action: AuditInput['action'], details: AuditDetails) =>
        this.#audit(tx, scope, userId, p.id, action, details);
      if (p.expiresAt <= new Date()) {
        await this.#proposals.decide(tx, scope.organizationId, p.id, { status: 'expired' });
        await audit('rule_change.expired', { proposalId: p.id, operation: p.operation });
        return { refused: 'proposal_expired' };
      }
      const { rows } = await tx.query<{ rev: string }>(
        `SELECT rule_revision::text AS rev FROM brand
          WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`,
        [scope.organizationId, scope.brandId],
      );
      if (!rows[0]) throw notFound();
      const result =
        Number(rows[0].rev) === p.baseRuleRevision
          ? validateRuleProposal(asInput(p), await this.#rules.list(scope, tx))
          : null;
      if (!result?.ok) {
        await this.#proposals.decide(tx, scope.organizationId, p.id, { status: 'stale' });
        await audit('rule_change.stale', { proposalId: p.id, operation: p.operation });
        return { refused: 'proposal_stale' };
      }

      const ruleId = await this.#apply(tx, scope, p, result.before, result.after, userId);
      await this.#proposals.decide(tx, scope.organizationId, p.id, {
        status: 'approved',
        decidedByUserId: userId,
        appliedRuleId: ruleId,
        ...(note !== undefined && { decisionNote: note }),
      });
      await audit('rule_change.approved', { proposalId: p.id, ruleId, operation: p.operation });
      return null;
    });
    if (settled) throw new ApiError(409, settled.refused);
    return this.get(org, scope.brandId, id);
  }

  async reject(
    org: OrgContext,
    brandId: unknown,
    id: string,
    note: string | undefined,
  ): Promise<RuleChangeView> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    await this.#decide(org, scope, id, async (tx, p) => {
      await this.#proposals.decide(tx, scope.organizationId, p.id, {
        status: 'rejected',
        decidedByUserId: org.actorUserId,
        ...(note !== undefined && { decisionNote: note }),
      });
      await this.#audit(tx, scope, org.actorUserId, p.id, 'rule_change.rejected', {
        proposalId: p.id,
        operation: p.operation,
        ...(p.targetRuleId !== null && { ruleId: p.targetRuleId }),
      });
      return null;
    });
    return this.get(org, scope.brandId, id);
  }

  /**
   * Runs `fn` on the pending proposal, locked, after re-reading the actor's role under the
   * organization lock. What `fn` writes commits even when it answers with a refusal.
   */
  #decide(
    org: OrgContext,
    scope: BrandScope,
    id: string,
    fn: (tx: pg.PoolClient, p: ProposalRow) => Promise<Settled | null>,
  ): Promise<Settled | null> {
    return withTransaction(this.deps.pool, async (tx) => {
      if (!can(await lockedActor(tx, org), 'rule.write')) throw new ApiError(403, 'forbidden');
      const p = await this.#proposals.get(tx, scope.organizationId, id, { forUpdate: true });
      if (p?.brandId !== scope.brandId) throw notFound();
      if (p.status !== 'pending') throw new ApiError(409, 'proposal_not_pending');
      try {
        return await fn(tx, p);
      } catch (e) {
        if (e instanceof ProposalNotPendingError) throw new ApiError(409, 'proposal_not_pending');
        throw e;
      }
    });
  }

  /** Applies an approved change through the dashboard's own rule writes; returns the rule id. */
  async #apply(
    tx: pg.PoolClient,
    scope: BrandScope,
    p: ProposalRow,
    before: RuleSnapshot | null,
    after: RuleSnapshot | null,
    userId: string,
  ): Promise<string> {
    if (p.operation === 'create') {
      const { rule } = await this.rulesService.applyCreate(tx, scope, after!, userId);
      return rule.id;
    }
    const ruleId = p.targetRuleId!;
    if (p.operation === 'archive') {
      await this.rulesService.applyArchive(tx, scope, ruleId, userId);
      return ruleId;
    }
    const patch = Object.fromEntries(
      ruleDiff(before, after).map((d) => [d.field, after![d.field]]),
    );
    await this.rulesService.applyUpdate(tx, scope, ruleId, patch, userId);
    return ruleId;
  }

  #audit(
    tx: pg.PoolClient,
    scope: BrandScope,
    userId: string,
    proposalId: string,
    action: AuditInput['action'],
    details: AuditDetails,
  ): Promise<void> {
    return recordAudit(tx, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      actorUserId: userId,
      action,
      subjectType: 'rule_change',
      subjectId: proposalId,
      details,
    });
  }

  async #views(db: pg.Pool, scope: BrandScope, rows: ProposalRow[]): Promise<RuleChangeView[]> {
    const { rows: brand } = await db.query<{ rev: string }>(
      'SELECT rule_revision::text AS rev FROM brand WHERE organization_id = $1 AND id = $2',
      [scope.organizationId, scope.brandId],
    );
    const currentRuleRevision = Number(brand[0]?.rev ?? 0);
    const { rows: names } = await db.query<{
      id: string;
      key_name: string;
      user_name: string | null;
    }>(
      `SELECT p.id, k.name AS key_name, u.display_name AS user_name
         FROM rule_change_proposal p
         JOIN api_key k ON k.organization_id = p.organization_id AND k.id = p.proposed_by_api_key_id
         LEFT JOIN app_user u ON u.id = p.decided_by_user_id
        WHERE p.organization_id = $1 AND p.id = ANY($2::uuid[])`,
      [scope.organizationId, rows.map((r) => r.id)],
    );
    const byId = new Map(names.map((n) => [n.id, n]));
    const now = new Date();
    return rows.map((p) => {
      const status = effectiveStatus(p, now);
      const n = byId.get(p.id);
      return {
        id: p.id,
        operation: p.operation,
        ruleId: p.appliedRuleId ?? p.targetRuleId,
        status,
        before: p.before,
        after: p.after,
        diff: p.diff,
        warnings: p.warnings,
        rationale: p.rationale,
        expiresAt: p.expiresAt.toISOString(),
        baseRuleRevision: p.baseRuleRevision,
        currentRuleRevision,
        isStale:
          status === 'stale' ||
          (status === 'pending' && currentRuleRevision !== p.baseRuleRevision),
        proposedBy: { apiKeyName: n?.key_name ?? '' },
        decidedBy: p.decidedByUserId
          ? { userId: p.decidedByUserId, name: n?.user_name ?? null }
          : null,
        decidedAt: p.decidedAt?.toISOString() ?? null,
        decisionNote: p.decisionNote,
      };
    });
  }
}
