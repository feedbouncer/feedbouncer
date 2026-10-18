// Export queries. Every tenant query has `organization_id = ANY($1::uuid[])` as the first
// predicate of every WHERE clause (sql.test.ts checks this), and all input is parameterised.
import type pg from 'pg';
import type {
  ActionFact,
  ClassificationFact,
  DecisionFact,
  LedgerFact,
  PolicyEvalFact,
  SuggestionFact,
} from './derive.js';

export const PAGE_SIZE = 1000;

export const TENANT_SQL = {
  brandsInOrgs: `
    SELECT id FROM brand
     WHERE organization_id = ANY($1::uuid[]) AND id = ANY($2::uuid[])`,

  // Keyset pagination on (posted_at, id); the cursor is posted_at as text, so microseconds survive.
  commentsPage: `
    SELECT c.id, c.organization_id, c.brand_id, c.connection_id, c.external_id, c.body,
           c.platform_state, c.posted_at, c.posted_at::text AS posted_at_key, c.ingested_at,
           c.ingest_origin, cn.platform
      FROM comment c
      JOIN connection cn ON cn.organization_id = c.organization_id AND cn.id = c.connection_id
     WHERE c.organization_id = ANY($1::uuid[])
       AND (cardinality($2::uuid[]) = 0 OR c.brand_id = ANY($2::uuid[]))
       AND c.posted_at >= $3::timestamptz AND c.posted_at < $4::timestamptz
       AND NOT c.is_own_account
       AND cn.platform IN ('facebook', 'instagram')
       AND ($5::timestamptz IS NULL OR (c.posted_at, c.id) > ($5::timestamptz, $6::uuid))
     ORDER BY c.posted_at, c.id
     LIMIT $7`,

  actions: `
    SELECT id, comment_id, kind, status, outcome_code, actor_type, rule_id, request_key,
           reverses_action_id, created_at, completed_at
      FROM moderation_action
     WHERE organization_id = ANY($1::uuid[]) AND comment_id = ANY($2::uuid[])
       AND kind IN ('hide', 'unhide', 'delete')`,

  ruleEvaluations: `
    SELECT comment_id, created_at, encode(body_sha256, 'hex') AS sha, status, review_mode
      FROM rule_evaluation
     WHERE organization_id = ANY($1::uuid[]) AND comment_id = ANY($2::uuid[])`,

  classifications: `
    SELECT comment_id, created_at, status, unclassified_reason, provider, model, prompt_version,
           scores_reused, rule_decided, language, review_mode, input_tokens, output_tokens,
           cache_read_tokens
      FROM comment_classification
     WHERE organization_id = ANY($1::uuid[]) AND comment_id = ANY($2::uuid[])`,

  policyEvaluations: `
    SELECT comment_id, created_at, status, failure_code, provider, model, prompt_version,
           review_mode, input_tokens, output_tokens, cache_read_tokens
      FROM policy_evaluation
     WHERE organization_id = ANY($1::uuid[]) AND comment_id = ANY($2::uuid[])`,

  decisions: `
    SELECT comment_id, outcome, mode, actor_type, category, rule_id, classification_id,
           policy_evaluation_id, reversal, sequence::float8 AS sequence
      FROM decision
     WHERE organization_id = ANY($1::uuid[]) AND comment_id = ANY($2::uuid[])`,

  suggestions: `
    SELECT s.id, s.comment_id, s.status, s.created_at, s.decided_at,
           (SELECT src.source_type FROM action_suggestion_source src
             WHERE src.organization_id = ANY($1::uuid[]) AND src.brand_id = s.brand_id AND src.suggestion_id = s.id
             ORDER BY src.created_at, src.id LIMIT 1) AS source_type
      FROM action_suggestion s
     WHERE s.organization_id = ANY($1::uuid[]) AND s.comment_id = ANY($2::uuid[])`,

  rules: `
    SELECT id, COALESCE(kind, conditions->>'type') AS kind
      FROM rule
     WHERE organization_id = ANY($1::uuid[]) AND id = ANY($2::uuid[])`,

  // Uses the (organization_id, idempotency_key) unique index.
  ledgers: `
    SELECT idempotency_key, job_type, created_at, first_claimed_at, failures, crashes, deferrals
      FROM job_ledger
     WHERE organization_id = ANY($1::uuid[]) AND idempotency_key = ANY($2::text[])`,
} as const;

/** Deployment-wide storage aggregate (not tenant data): total size of the tables, per comment. */
const BYTES_SQL = `
  SELECT (SELECT sum(pg_total_relation_size(to_regclass(t)))::float8 FROM unnest($1::text[]) t) AS bytes,
         (SELECT count(*)::float8 FROM comment) AS comments`;

const STORAGE_TABLES = [
  'comment',
  'decision',
  'rule_evaluation',
  'comment_classification',
  'policy_evaluation',
  'moderation_action',
  'job_ledger',
];

export type CommentRow = {
  id: string;
  organizationId: string;
  brandId: string;
  connectionId: string;
  externalId: string;
  body: string;
  platformState: 'visible' | 'hidden' | 'deleted';
  postedAt: Date;
  postedAtKey: string;
  ingestedAt: Date;
  origin: 'live' | 'backfill';
  platform: 'facebook' | 'instagram';
};

export type Cursor = { postedAtKey: string; id: string } | null;

type Scope = { orgs: readonly string[]; brands: readonly string[]; from: Date; to: Date };

export async function brandsInOrgs(
  pool: pg.Pool,
  orgs: readonly string[],
  brands: readonly string[],
): Promise<Set<string>> {
  const r = await pool.query<{ id: string }>(TENANT_SQL.brandsInOrgs, [orgs, brands]);
  return new Set(r.rows.map((x) => x.id));
}

export async function commentsPage(pool: pg.Pool, s: Scope, cursor: Cursor): Promise<CommentRow[]> {
  const r = await pool.query<{
    id: string;
    organization_id: string;
    brand_id: string;
    connection_id: string;
    external_id: string;
    body: string;
    platform_state: CommentRow['platformState'];
    posted_at: Date;
    posted_at_key: string;
    ingested_at: Date;
    ingest_origin: CommentRow['origin'];
    platform: CommentRow['platform'];
  }>(TENANT_SQL.commentsPage, [
    s.orgs,
    s.brands,
    s.from,
    s.to,
    cursor?.postedAtKey ?? null,
    cursor?.id ?? null,
    PAGE_SIZE,
  ]);
  return r.rows.map((x) => ({
    id: x.id,
    organizationId: x.organization_id,
    brandId: x.brand_id,
    connectionId: x.connection_id,
    externalId: x.external_id,
    body: x.body,
    platformState: x.platform_state,
    postedAt: x.posted_at,
    postedAtKey: x.posted_at_key,
    ingestedAt: x.ingested_at,
    origin: x.ingest_origin,
    platform: x.platform,
  }));
}

const group = <T>(rows: readonly (T & { commentId: string })[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.commentId);
    if (list) list.push(r);
    else m.set(r.commentId, [r]);
  }
  return m;
};

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

export type RelatedRows = {
  actions: Map<string, ActionFact[]>;
  ruleEvals: Map<string, { createdAt: Date; sha: string; status: string; reviewMode: boolean }[]>;
  classifications: Map<string, ClassificationFact[]>;
  policyEvals: Map<string, PolicyEvalFact[]>;
  decisions: Map<string, DecisionFact[]>;
  suggestions: Map<string, (SuggestionFact & { id: string })[]>;
};

/** One `= ANY($2)` query per related table for a page of comment ids. */
export async function relatedRows(
  pool: pg.Pool,
  orgs: readonly string[],
  ids: readonly string[],
): Promise<RelatedRows> {
  const p = [orgs, ids];
  const [a, re, cl, pe, de, su] = await Promise.all([
    pool.query(TENANT_SQL.actions, p),
    pool.query(TENANT_SQL.ruleEvaluations, p),
    pool.query(TENANT_SQL.classifications, p),
    pool.query(TENANT_SQL.policyEvaluations, p),
    pool.query(TENANT_SQL.decisions, p),
    pool.query(TENANT_SQL.suggestions, p),
  ]);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type Row = Record<string, any>;
  return {
    actions: group(
      a.rows.map((x: Row) => ({
        commentId: x.comment_id,
        id: x.id,
        kind: x.kind,
        status: x.status,
        outcomeCode: x.outcome_code,
        actorType: x.actor_type,
        ruleId: x.rule_id,
        requestKey: x.request_key,
        reversesActionId: x.reverses_action_id,
        createdAt: x.created_at,
        completedAt: x.completed_at,
      })),
    ),
    ruleEvals: group(
      re.rows.map((x: Row) => ({
        commentId: x.comment_id,
        createdAt: x.created_at,
        sha: x.sha,
        status: x.status,
        reviewMode: x.review_mode,
      })),
    ),
    classifications: group(
      cl.rows.map((x: Row) => ({
        commentId: x.comment_id,
        createdAt: x.created_at,
        status: x.status,
        unclassifiedReason: x.unclassified_reason,
        provider: x.provider,
        model: x.model,
        promptVersion: x.prompt_version,
        scoresReused: x.scores_reused,
        ruleDecided: x.rule_decided,
        language: x.language,
        reviewMode: x.review_mode,
        inputTokens: num(x.input_tokens),
        outputTokens: num(x.output_tokens),
        cacheReadTokens: num(x.cache_read_tokens),
      })),
    ),
    policyEvals: group(
      pe.rows.map((x: Row) => ({
        commentId: x.comment_id,
        createdAt: x.created_at,
        status: x.status,
        failureCode: x.failure_code,
        provider: x.provider,
        model: x.model,
        promptVersion: x.prompt_version,
        reviewMode: x.review_mode,
        inputTokens: num(x.input_tokens),
        outputTokens: num(x.output_tokens),
        cacheReadTokens: num(x.cache_read_tokens),
      })),
    ),
    decisions: group(
      de.rows.map((x: Row) => ({
        commentId: x.comment_id,
        outcome: x.outcome,
        mode: x.mode,
        actorType: x.actor_type,
        category: x.category,
        ruleId: x.rule_id,
        classificationId: x.classification_id,
        policyEvaluationId: x.policy_evaluation_id,
        reversal: x.reversal,
        sequence: Number(x.sequence),
      })),
    ),
    suggestions: group(
      su.rows.map((x: Row) => ({
        commentId: x.comment_id,
        id: x.id,
        status: x.status,
        createdAt: x.created_at,
        decidedAt: x.decided_at,
        sourceType: x.source_type,
      })),
    ),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export async function ruleKinds(
  pool: pg.Pool,
  orgs: readonly string[],
  ruleIds: readonly string[],
): Promise<Map<string, string>> {
  if (ruleIds.length === 0) return new Map();
  const r = await pool.query<{ id: string; kind: string | null }>(TENANT_SQL.rules, [orgs, ruleIds]);
  return new Map(r.rows.filter((x) => x.kind !== null).map((x) => [x.id, x.kind!]));
}

export type LedgerHit = LedgerFact & { jobType: string };

export async function ledgersByKey(
  pool: pg.Pool,
  orgs: readonly string[],
  keys: readonly string[],
): Promise<Map<string, LedgerHit>> {
  if (keys.length === 0) return new Map();
  const r = await pool.query<{
    idempotency_key: string;
    job_type: string;
    created_at: Date;
    first_claimed_at: Date | null;
    failures: number;
    crashes: number;
    deferrals: number;
  }>(TENANT_SQL.ledgers, [orgs, keys]);
  return new Map(
    r.rows.map((x) => [
      x.idempotency_key,
      {
        jobType: x.job_type,
        createdAt: x.created_at,
        firstClaimedAt: x.first_claimed_at,
        failures: x.failures,
        crashes: x.crashes,
        deferrals: x.deferrals,
      },
    ]),
  );
}

/** Bytes per stored comment across the deployment; null without privileges or comments. */
export async function bytesPerComment(pool: pg.Pool): Promise<number | null> {
  try {
    const r = await pool.query<{ bytes: number | null; comments: number }>(BYTES_SQL, [
      STORAGE_TABLES,
    ]);
    const row = r.rows[0];
    if (!row || row.bytes === null || row.comments === 0) return null;
    return row.bytes / row.comments;
  } catch (e) {
    if ((e as { code?: unknown }).code === '42501') return null;
    throw e;
  }
}
