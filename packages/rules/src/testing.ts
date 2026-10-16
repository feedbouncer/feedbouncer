// Integration-test helpers: comment and rule-evaluation seeding and a fake JobContext shared by the classifier and policies suites.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Tenant } from '@feedbouncer/db/testing';
import type { JobContext } from '@feedbouncer/jobs';
import { bodySha256 } from './jobs/specs.js';
import type { PgEvaluationStore } from './evaluations.js';
import type { Logger } from '@feedbouncer/service-runtime';

export interface Seeded {
  id: string;
  body: string;
  t: Tenant;
}

export const scopeOf = (t: Tenant, connectionId = t.connectionId) => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  connectionId,
});

export async function seedCommentRow(
  c: pg.ClientBase,
  tn: Tenant,
  body: string,
  o: { state?: string; own?: boolean } = {},
): Promise<Seeded> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, platform_state,
       is_own_account, ingest_origin, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'live', now()) RETURNING id`,
    [
      tn.organizationId,
      tn.brandId,
      tn.connectionId,
      tn.sourceId,
      `ext-${randomUUID()}`,
      body,
      o.state ?? 'visible',
      o.own ?? false,
    ],
  );
  return { id: r.rows[0]!.id, body, t: tn };
}

export async function editCommentRow(c: pg.ClientBase, s: Seeded, body: string): Promise<Seeded> {
  await c.query('UPDATE comment SET body = $2 WHERE id = $1', [s.id, body]);
  return { ...s, body };
}

export async function evaluateRulesFor(
  evaluations: PgEvaluationStore,
  c: Seeded,
  status: 'no_match' | 'decided' | 'skipped',
): Promise<void> {
  const row = await evaluations.record(scopeOf(c.t), {
    commentId: c.id,
    sha: Buffer.from(bodySha256(c.body), 'hex'),
    triggerKey: 'ingest',
    rulesetVersion: 'v1',
    status,
    ...(status === 'skipped' ? { skipReason: 'own_account' as const } : {}),
    verdict:
      status === 'decided'
        ? {
            decided: {
              ruleId: c.t.ruleId,
              ruleName: 'Rule',
              kind: 'keyword',
              action: 'hide',
              evidence: { kind: 'keyword', term: 'x' },
            },
            suggestions: [],
            trace: [],
          }
        : { decided: null, suggestions: [], trace: [] },
  });
  if (!row) throw new Error('evaluation not recorded');
}

export function fakeJobContext(
  t: Tenant,
  attempt: number,
  jobType: string,
  log: Logger,
  connectionId = t.connectionId,
): JobContext {
  return {
    scope: scopeOf(t, connectionId),
    platform: 'facebook',
    jobType,
    ledgerId: randomUUID(),
    attempt,
    isReplay: false,
    signal: new AbortController().signal,
    log,
  };
}
