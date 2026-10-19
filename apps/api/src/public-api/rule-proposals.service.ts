import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { isUniqueViolation, recordAuditEvent, withTransaction } from '@feedbouncer/db';
import type { ApiKeyContext, ProposeRuleChangeBody, StoredResponse } from '@feedbouncer/public-api';
import {
  MAX_PENDING_PROPOSALS_PER_BRAND,
  MAX_RULES_PER_BRAND,
  PgRuleProposalStore,
  PgRuleStore,
  effectiveStatus,
  ruleDiff,
  validateRuleProposal,
  type ProposalResult,
  type ProposalRow,
  type StoredRule,
} from '@feedbouncer/rules';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { DEPS } from '../tokens.js';
import { requestKey } from './idempotent.js';

const CHANGES_WINDOW_MS = 7 * 86_400_000;

type ProposeBody = z.infer<typeof ProposeRuleChangeBody>;

function rejection(r: Extract<ProposalResult, { ok: false }>): ApiError {
  // A rule outside this brand, archived or unknown, is not visible to the caller.
  if (r.reason === 'unknown_rule') return notFound();
  if (r.reason === 'rule_limit_reached')
    return new ApiError(409, 'rule_limit_reached', undefined, { max: MAX_RULES_PER_BRAND });
  return new ApiError(422, 'rule_rejected', r.message, {
    reason: r.reason,
    ...(r.ruleId !== undefined && { ruleId: r.ruleId }),
  });
}

const toRuleResource = (r: StoredRule) => ({
  id: r.id,
  name: r.name,
  conditions: r.conditions,
  actions: r.actions,
  mode: r.mode,
  priority: r.priority,
  enabled: r.enabled,
});

const toChangeSummary = (p: ProposalRow) => ({
  id: p.id,
  operation: p.operation,
  ruleId: p.targetRuleId,
  status: effectiveStatus(p),
  expiresAt: p.expiresAt.toISOString(),
  decidedAt: p.decidedAt?.toISOString() ?? null,
});

/** Rules as the public API sees them, and rule changes proposed for a person to approve. */
@Injectable()
export class PublicRuleProposalsService {
  readonly #rules: PgRuleStore;
  readonly #proposals = new PgRuleProposalStore();

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#rules = new PgRuleStore(deps.pool);
  }

  /** Live brands of the key's organization (or the one asked for), read in one snapshot. */
  async ruleSet(key: ApiKeyContext, brandId: string | undefined) {
    const orgId = key.organizationId;
    const brands = await withTransaction(
      this.deps.pool,
      async (c) => {
        await c.query('SET TRANSACTION READ ONLY');
        const { rows } = await c.query<{ id: string; name: string; rev: string }>(
          `SELECT id, name, rule_revision::text AS rev FROM brand
            WHERE organization_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id = $2)
            ORDER BY created_at, id`,
          [orgId, brandId ?? null],
        );
        if (brandId && rows.length === 0) throw notFound();
        const since = new Date(Date.now() - CHANGES_WINDOW_MS);
        const out = [];
        for (const b of rows) {
          const rules = await this.#rules.list({ organizationId: orgId, brandId: b.id }, c);
          const changes = await this.#proposals.list(c, orgId, b.id, { since });
          out.push({
            id: b.id,
            name: b.name,
            ruleRevision: Number(b.rev),
            rules: rules.map(toRuleResource),
            changes: changes.map(toChangeSummary),
          });
        }
        return out;
      },
      { isolation: 'repeatable read' },
    );
    return { brands };
  }

  /** 201 with a new pending proposal, 200 with the pending one when the same change waits already. */
  async propose(
    key: ApiKeyContext,
    body: ProposeBody,
    idempotencyKey: string | undefined,
  ): Promise<StoredResponse> {
    const orgId = key.organizationId;
    const { brandId, operation } = body;
    const targetRuleId = body.operation === 'create' ? null : body.ruleId;
    const { status, row } = await withTransaction(this.deps.pool, async (tx) => {
      // Serializes with rule writers and other proposals of the brand until commit.
      const brand = await tx.query<{ rev: string }>(
        `SELECT rule_revision::text AS rev FROM brand
          WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR NO KEY UPDATE`,
        [orgId, brandId],
      );
      if (!brand.rows[0]) throw notFound();
      const baseRuleRevision = Number(brand.rows[0].rev);
      const current = await this.#rules.list({ organizationId: orgId, brandId }, tx);
      const result = validateRuleProposal(body, current);
      if (!result.ok) throw rejection(result);

      const dup = await this.#proposals.findPendingDuplicate(
        tx,
        brandId,
        operation,
        targetRuleId,
        result.after,
        baseRuleRevision,
      );
      if (dup) return { status: 200 as const, row: dup };
      if ((await this.#proposals.countPending(tx, brandId)) >= MAX_PENDING_PROPOSALS_PER_BRAND)
        throw new ApiError(409, 'pending_limit_reached', undefined, {
          max: MAX_PENDING_PROPOSALS_PER_BRAND,
        });

      const created = await this.#proposals
        .create(tx, {
          organizationId: orgId,
          brandId,
          operation,
          targetRuleId,
          before: result.before,
          after: result.after,
          diff: ruleDiff(result.before, result.after).map((d) => ({
            field: d.field,
            before: d.before ?? null,
            after: d.after ?? null,
          })),
          warnings: result.warnings,
          rationale: body.rationale ?? null,
          baseRuleRevision,
          proposedByApiKeyId: key.apiKeyId,
          requestKey: requestKey(key.apiKeyId, idempotencyKey),
          ttlHours: this.deps.env.ruleProposalTtlHours,
        })
        .catch((err: unknown) => {
          // The Idempotency-Key outlived its stored response and now names another request.
          if (isUniqueViolation(err, 'rule_change_proposal_organization_id_request_key_key'))
            throw new ApiError(422, 'idempotency_key_reused');
          throw err;
        });
      await recordAuditEvent(tx, {
        organizationId: orgId,
        brandId,
        actorType: 'api_key',
        action: 'rule_change.proposed',
        subjectType: 'rule_change',
        subjectId: created.id,
        details: {
          apiKeyId: key.apiKeyId,
          operation,
          ...(targetRuleId !== null && { ruleId: targetRuleId }),
        },
      });
      return { status: 201 as const, row: created };
    });
    return { status, body: this.#resource(row) };
  }

  #resource(p: ProposalRow) {
    return {
      id: p.id,
      brandId: p.brandId,
      operation: p.operation,
      ruleId: p.targetRuleId,
      status: effectiveStatus(p),
      diff: p.diff,
      warnings: p.warnings,
      expiresAt: p.expiresAt.toISOString(),
      baseRuleRevision: p.baseRuleRevision,
      reviewUrl: `${this.deps.env.publicWebUrl.origin}/orgs/${p.organizationId}/brands/${p.brandId}/rules/changes/${p.id}`,
    };
  }
}
