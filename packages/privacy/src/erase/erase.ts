import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import { recordSystemAudit } from '@feedbouncer/actions';
import {
  commentFingerprint,
  withPrivacyRedaction,
  withRetentionDelete,
  withTransaction,
} from '@feedbouncer/db';
import { PgRuleStore, type RuleConditions } from '@feedbouncer/rules';
import type { Logger } from '@feedbouncer/service-runtime';
import { FINISHED_JOB_STATES } from '../purge/categories.js';
import { countReplies, markRepliesParentRemoved } from '../replies.js';
import type { SubjectIdentifierT } from '../subject/identifier.js';
import { locateAuthorIds } from '../subject/locate.js';
import {
  AUTHOR_NODE,
  authorRules,
  entryMatches,
  ERASED,
  redactAuthorEntries,
  removeAuthorEntries,
  type AuthorRule,
  type EntryMatch,
} from './rule-entries.js';

export type ErasureCounts = {
  comments: number;
  authors: number;
  repliesMarkedParentRemoved: number;
  reviewItemsCancelled: number;
  suggestionsCancelled: number;
  decisions: number;
  previewResults: number;
  moderationActions: number;
  ruleEntriesRemoved: number;
  rulesDisabled: number;
  ruleEntriesKept: number;
  proposalsRedacted: number;
  auditEventsRedacted: number;
  idempotencyRecords: number;
  jobLedgerRows: number;
};

export interface ErasureResult {
  found: boolean;
  counts: ErasureCounts;
  /** Comments ingested for the subject before `completedAt` are erased; later ones are new data. */
  coverage: 'all_ingested_before_completed_at';
  completedAt: Date;
}

export interface ErasureOptions {
  /** Count only, in a read-only transaction: nothing is written. */
  dryRun: boolean;
  /** Keep matching rule entries (counted as ruleEntriesKept) instead of removing them. */
  keepRuleEntries: { reason: string } | null;
  batchSize: number;
  log: Logger;
  /**
   * Progress callback: after each committed batch of comments, before the final author
   * transaction, and once the author rows are deleted.
   */
  onStep?: (step: ErasureStep) => Promise<void>;
}

export type ErasureStep = 'comment_batch' | 'before_authors' | 'authors_deleted';

const zeroCounts = (): ErasureCounts => ({
  comments: 0,
  authors: 0,
  repliesMarkedParentRemoved: 0,
  reviewItemsCancelled: 0,
  suggestionsCancelled: 0,
  decisions: 0,
  previewResults: 0,
  moderationActions: 0,
  ruleEntriesRemoved: 0,
  rulesDisabled: 0,
  ruleEntriesKept: 0,
  proposalsRedacted: 0,
  auditEventsRedacted: 0,
  idempotencyRecords: 0,
  jobLedgerRows: 0,
});

function add(into: ErasureCounts, part: Partial<ErasureCounts>): void {
  for (const [k, v] of Object.entries(part)) into[k as keyof ErasureCounts] += v;
}

interface SubjectComment {
  id: string;
  connection_id: string;
  external_id: string;
}

const SUBJECT_COMMENTS = `SELECT id, connection_id, external_id FROM comment
  WHERE organization_id = $1 AND author_id = ANY($2::uuid[])`;

/** Rows that cascade with the comments $2, as the result reports them. */
async function countChildren(c: pg.ClientBase, organizationId: string, ids: readonly string[]) {
  const of = (table: string, extra = '') =>
    `(SELECT count(*) FROM ${table}
       WHERE organization_id = $1 AND comment_id = ANY($2::uuid[])${extra})`;
  const { rows } = await c.query<Record<string, string>>(
    `SELECT ${of('decision')} AS decisions,
            ${of('review_item', ` AND status = 'open'`)} AS review_items,
            ${of('action_suggestion', ` AND status = 'pending'`)} AS suggestions,
            ${of('policy_preview_result')} AS preview_results,
            ${of('moderation_action')} AS moderation_actions`,
    [organizationId, ids],
  );
  const r = rows[0]!;
  return {
    decisions: Number(r.decisions),
    reviewItemsCancelled: Number(r.review_items),
    suggestionsCancelled: Number(r.suggestions),
    previewResults: Number(r.preview_results),
    moderationActions: Number(r.moderation_actions),
  } satisfies Partial<ErasureCounts>;
}

function withoutSubject(conditions: unknown, matches: readonly EntryMatch[]) {
  let out = conditions as RuleConditions;
  let removed = 0;
  let emptied = false;
  for (const m of matches) {
    const r = removeAuthorEntries(out, m);
    out = r.conditions;
    removed += r.removed;
    emptied ||= r.emptied;
  }
  return { conditions: out, removed, emptied };
}

/** What handling the rule entries would do, without writing. */
function countRuleEntries(
  rules: readonly AuthorRule[],
  matches: readonly EntryMatch[],
  keep: boolean,
): Partial<ErasureCounts> {
  const counts = { ruleEntriesRemoved: 0, rulesDisabled: 0, ruleEntriesKept: 0 };
  for (const rule of rules) {
    const r = withoutSubject(rule.conditions, matches);
    if (keep) counts.ruleEntriesKept += r.removed;
    else {
      counts.ruleEntriesRemoved += r.removed;
      if (r.emptied && rule.enabled) counts.rulesDisabled += 1;
    }
  }
  return counts;
}

/**
 * Removes the entries through the rule store, one rule per transaction, so the brand's
 * revision is bumped and rule-set caches reload. A rule left with an empty author list is
 * disabled. Each change is audited as the system, with counts only.
 */
async function removeRuleEntries(
  pool: pg.Pool,
  organizationId: string,
  matches: readonly EntryMatch[],
): Promise<Partial<ErasureCounts>> {
  const store = new PgRuleStore(pool);
  const counts = { ruleEntriesRemoved: 0, rulesDisabled: 0 };
  for (const rule of await authorRules(pool, organizationId)) {
    if (withoutSubject(rule.conditions, matches).removed === 0) continue;
    const change = await withTransaction(pool, async (tx) => {
      const done = { removed: 0, disabled: false };
      const written = await store.writeErasedConditions(
        tx,
        { organizationId, brandId: rule.brand_id },
        rule.id,
        (current) => {
          const r = withoutSubject(current.conditions, matches);
          if (r.removed === 0) return null;
          done.removed = r.removed;
          done.disabled = r.emptied && current.enabled;
          return { conditions: r.conditions, disable: r.emptied };
        },
      );
      if (!written) return null;
      await recordSystemAudit(tx, {
        organizationId,
        brandId: rule.brand_id,
        action: 'rule.updated',
        subjectType: 'rule',
        subjectId: rule.id,
        details: {
          kind: written.kind,
          changed: done.disabled ? 'conditions,enabled' : 'conditions',
          enabled: written.enabled,
          entriesRemoved: done.removed,
        },
      });
      return done;
    });
    if (!change) continue;
    counts.ruleEntriesRemoved += change.removed;
    if (change.disabled) counts.rulesDisabled += 1;
  }
  return counts;
}

interface Proposal {
  id: string;
  before: unknown;
  after: unknown;
  diff: unknown;
}

const PROPOSALS = `SELECT id, before, after, diff FROM rule_change_proposal
  WHERE organization_id = $1
    AND (before @? ${AUTHOR_NODE} OR after @? ${AUTHOR_NODE} OR diff @? ${AUTHOR_NODE})`;

/** The proposal's snapshots and diff with the subject's entries redacted, or null if none match. */
function redactProposal(p: Proposal, matches: readonly EntryMatch[]) {
  const r = redactAuthorEntries({ before: p.before, after: p.after, diff: p.diff }, matches);
  return r.redacted === 0 ? null : (r.value as Pick<Proposal, 'before' | 'after' | 'diff'>);
}

/** A null snapshot stays SQL NULL rather than becoming JSON null. */
const jsonOrNull = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

/** Redacts each matching proposal in its own transaction; a pending one becomes stale. */
async function redactProposals(
  pool: pg.Pool,
  organizationId: string,
  matches: readonly EntryMatch[],
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM (${PROPOSALS}) p ORDER BY id`, [
    organizationId,
  ]);
  let redacted = 0;
  for (const { id } of rows) {
    const hit = await withTransaction(pool, async (tx) => {
      const cur = await tx.query<Proposal>(`${PROPOSALS} AND id = $2 FOR UPDATE`, [
        organizationId,
        id,
      ]);
      const next = cur.rows[0] ? redactProposal(cur.rows[0], matches) : null;
      if (!next) return false;
      await tx.query(
        `UPDATE rule_change_proposal
            SET before = $3::jsonb, after = $4::jsonb, diff = $5::jsonb,
                decided_at = CASE WHEN status = 'pending' THEN now() ELSE decided_at END,
                status = CASE WHEN status = 'pending' THEN 'stale' ELSE status END
          WHERE organization_id = $1 AND id = $2`,
        [
          organizationId,
          id,
          jsonOrNull(next.before),
          jsonOrNull(next.after),
          JSON.stringify(next.diff),
        ],
      );
      return true;
    });
    if (hit) redacted += 1;
  }
  return redacted;
}

/** Audit events of $1 holding one of the strings $2 as a JSON string value, at any depth. */
const AUDIT_MATCH = `x.organization_id = $1 AND EXISTS (
  SELECT 1 FROM unnest($2::text[]) AS t(v)
   WHERE jsonb_path_exists(x.details, '$.** ? (@ == $v)', jsonb_build_object('v', t.v)))`;

/** Every string value equal to one of `terms` becomes "[erased]"; keys and other values stay. */
function redactStrings(v: unknown, terms: ReadonlySet<string>): unknown {
  if (typeof v === 'string') return terms.has(v) ? ERASED : v;
  if (Array.isArray(v)) return v.map((x) => redactStrings(x, terms));
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactStrings(x, terms)]));
  return v;
}

/** Rewrites the details of matching audit events, in batches, through the redaction hatch. */
async function redactAuditEvents(
  pool: pg.Pool,
  organizationId: string,
  terms: readonly string[],
  batchSize: number,
): Promise<number> {
  const set = new Set(terms);
  let after = '0';
  let redacted = 0;
  for (;;) {
    const rows = await withTransaction(pool, (tx) =>
      withPrivacyRedaction(tx, async () => {
        const batch = await tx.query<{ id: string; sequence: string; details: unknown }>(
          `SELECT x.id, x.sequence, x.details FROM audit_event x
            WHERE ${AUDIT_MATCH} AND x.sequence > $3
            ORDER BY x.sequence LIMIT $4 FOR UPDATE`,
          [organizationId, terms, after, batchSize],
        );
        for (const r of batch.rows) {
          await tx.query(
            'UPDATE audit_event SET details = $3::jsonb WHERE organization_id = $1 AND id = $2',
            [organizationId, r.id, JSON.stringify(redactStrings(r.details, set))],
          );
        }
        return batch.rows;
      }),
    );
    redacted += rows.length;
    if (rows.length < batchSize) return redacted;
    after = rows.at(-1)!.sequence;
  }
}

/** Idempotency records of $1 whose stored response mentions one of the comment ids $2. */
const IDEMPOTENCY_MATCH = `x.organization_id = $1 AND EXISTS (
  SELECT 1 FROM unnest($2::text[]) AS u(id) WHERE strpos(x.response_body::text, u.id) > 0)`;

/** Finished ledger rows of $1 whose payload holds one of the comment external ids ($2, $3). */
const LEDGER_MATCH = `x.organization_id = $1 AND x.state = ANY($4::text[]) AND EXISTS (
  SELECT 1 FROM unnest($2::uuid[], $3::text[]) AS e(connection_id, external_id)
   WHERE x.connection_id = e.connection_id
     AND jsonb_path_exists(x.payload, '$.** ? (@ == $v)', jsonb_build_object('v', e.external_id)))`;

function operationalParams(organizationId: string, comments: readonly SubjectComment[]) {
  return {
    idempotency: [organizationId, comments.map((c) => c.id)],
    ledger: [
      organizationId,
      comments.map((c) => c.connection_id),
      comments.map((c) => c.external_id),
      FINISHED_JOB_STATES,
    ],
  };
}

async function countWhere(
  c: pg.ClientBase,
  table: string,
  where: string,
  params: unknown[],
): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} x WHERE ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

async function deleteWhere(
  c: pg.ClientBase,
  table: string,
  where: string,
  params: unknown[],
): Promise<number> {
  const r = await c.query(`DELETE FROM ${table} x WHERE ${where}`, params);
  return r.rowCount ?? 0;
}

/**
 * One batch of the subject's comments, erased in one transaction together with the cached
 * responses and finished job records that mention them, so a retry never finds comments
 * gone and their operational copies left behind.
 */
async function eraseCommentBatch(
  pool: pg.Pool,
  organizationId: string,
  authorIds: readonly string[],
  batchSize: number,
): Promise<{ comments: SubjectComment[]; counts: Partial<ErasureCounts> }> {
  return withTransaction(pool, (tx) =>
    withRetentionDelete(tx, async () => {
      const { rows } = await tx.query<SubjectComment>(
        `${SUBJECT_COMMENTS} ORDER BY id LIMIT $3 FOR UPDATE`,
        [organizationId, authorIds, batchSize],
      );
      if (rows.length === 0) return { comments: [], counts: {} };
      const ids = rows.map((r) => r.id);
      const children = await countChildren(tx, organizationId, ids);
      const replies = await markRepliesParentRemoved(tx, ids, authorIds);
      await tx.query(
        `INSERT INTO erased_comment (connection_id, fingerprint)
         SELECT * FROM unnest($1::uuid[], $2::bytea[]) ON CONFLICT DO NOTHING`,
        [
          rows.map((r) => r.connection_id),
          rows.map((r) => commentFingerprint(r.connection_id, r.external_id)),
        ],
      );
      const deleted = await tx.query(
        'DELETE FROM comment WHERE organization_id = $1 AND id = ANY($2::uuid[])',
        [organizationId, ids],
      );
      const p = operationalParams(organizationId, rows);
      return {
        comments: rows,
        counts: {
          ...children,
          repliesMarkedParentRemoved: replies,
          comments: deleted.rowCount ?? 0,
          idempotencyRecords: await deleteWhere(
            tx,
            'api_idempotency_record',
            IDEMPOTENCY_MATCH,
            p.idempotency,
          ),
          jobLedgerRows: await deleteWhere(tx, 'job_ledger', LEDGER_MATCH, p.ledger),
        },
      };
    }),
  );
}

/**
 * Deletes the subject's author rows once no comment refers to them, in one locked
 * transaction. Returns the rows deleted, or the author ids to go back to the comments with:
 * a comment arrived meanwhile, or the subject now has an author row on another connection.
 */
async function deleteAuthors(
  pool: pg.Pool,
  organizationId: string,
  subjects: readonly SubjectIdentifierT[],
  authorIds: readonly string[],
): Promise<{ deleted: number } | { retryWith: string[] }> {
  return withTransaction(pool, async (tx) => {
    await tx.query(
      'SELECT 1 FROM author WHERE organization_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE',
      [organizationId, authorIds],
    );
    const found = await locateAuthorIds(tx, organizationId, subjects);
    const all = [...new Set([...authorIds, ...found])];
    const left = await tx.query(`${SUBJECT_COMMENTS} LIMIT 1`, [organizationId, all]);
    if (all.length > authorIds.length || (left.rowCount ?? 0) > 0) return { retryWith: all };
    const r = await tx.query(
      'DELETE FROM author WHERE organization_id = $1 AND id = ANY($2::uuid[])',
      [organizationId, authorIds],
    );
    return { deleted: r.rowCount ?? 0 };
  });
}

async function execute(
  pool: pg.Pool,
  organizationId: string,
  subjects: readonly SubjectIdentifierT[],
  o: ErasureOptions,
): Promise<{ counts: ErasureCounts; authorIds: string[]; completedAt: Date }> {
  const counts = zeroCounts();
  const matches = entryMatches(subjects);
  let authorIds = await locateAuthorIds(pool, organizationId, subjects);

  for (;;) {
    for (;;) {
      const batch = await eraseCommentBatch(pool, organizationId, authorIds, o.batchSize);
      if (batch.comments.length === 0) break;
      add(counts, batch.counts);
      o.log.debug('privacy.erasure_batch', { organizationId, comments: batch.comments.length });
      await o.onStep?.('comment_batch');
    }
    await o.onStep?.('before_authors');
    const authors = await deleteAuthors(pool, organizationId, subjects, authorIds);
    if ('deleted' in authors) {
      counts.authors = authors.deleted;
      break;
    }
    authorIds = authors.retryWith;
  }
  const completedAt = new Date();
  await o.onStep?.('authors_deleted');

  add(
    counts,
    o.keepRuleEntries
      ? countRuleEntries(await authorRules(pool, organizationId), matches, true)
      : await removeRuleEntries(pool, organizationId, matches),
  );
  counts.proposalsRedacted = await redactProposals(pool, organizationId, matches);
  counts.auditEventsRedacted = await redactAuditEvents(
    pool,
    organizationId,
    redactionTerms(subjects),
    o.batchSize,
  );
  return { counts, authorIds, completedAt };
}

/** The same predicates as `execute`, counted in one read-only snapshot. */
async function dryRun(
  pool: pg.Pool,
  organizationId: string,
  subjects: readonly SubjectIdentifierT[],
  o: ErasureOptions,
): Promise<{ counts: ErasureCounts; authorIds: string[]; completedAt: Date }> {
  return withTransaction(
    pool,
    async (tx) => {
      const counts = zeroCounts();
      const matches = entryMatches(subjects);
      const authorIds = await locateAuthorIds(tx, organizationId, subjects);
      const { rows } = await tx.query<SubjectComment>(SUBJECT_COMMENTS, [
        organizationId,
        authorIds,
      ]);
      const ids = rows.map((r) => r.id);
      counts.comments = rows.length;
      counts.authors = authorIds.length;
      add(counts, await countChildren(tx, organizationId, ids));
      counts.repliesMarkedParentRemoved = await countReplies(tx, ids, authorIds);
      add(
        counts,
        countRuleEntries(
          await authorRules(tx, organizationId),
          matches,
          o.keepRuleEntries !== null,
        ),
      );
      const proposals = await tx.query<Proposal>(PROPOSALS, [organizationId]);
      counts.proposalsRedacted = proposals.rows.filter(
        (p) => redactProposal(p, matches) !== null,
      ).length;
      counts.auditEventsRedacted = await countWhere(tx, 'audit_event', AUDIT_MATCH, [
        organizationId,
        redactionTerms(subjects),
      ]);
      const p = operationalParams(organizationId, rows);
      counts.idempotencyRecords = await countWhere(
        tx,
        'api_idempotency_record',
        IDEMPOTENCY_MATCH,
        p.idempotency,
      );
      counts.jobLedgerRows = await countWhere(tx, 'job_ledger', LEDGER_MATCH, p.ledger);
      return { counts, authorIds, completedAt: new Date() };
    },
    { isolation: 'repeatable read', readOnly: true },
  );
}

/** The strings redacted from audit details: the requested external ids and handles. */
function redactionTerms(subjects: readonly SubjectIdentifierT[]): string[] {
  const terms = new Set<string>();
  for (const s of subjects) {
    if (s.externalId !== undefined) terms.add(s.externalId);
    if (s.handle !== undefined) terms.add(s.handle);
  }
  return [...terms];
}

/**
 * Erases one subject from one organization: their comments (with everything that cascades
 * from them), their author rows, their rule entries (unless kept), and their identifiers in
 * rule-change proposals, audit details and operational records. Replies by other people
 * stay, marked as replying to a removed comment. Comments are erased in batches until none
 * is left, then the author rows go in a final locked transaction, so every comment
 * ingested before the result's `completedAt` is covered. A dry run counts the same rows
 * and writes nothing. Logs ids and counts only.
 */
export async function eraseSubject(
  pool: pg.Pool,
  organizationId: string,
  subjects: SubjectIdentifierT[],
  o: ErasureOptions,
): Promise<ErasureResult> {
  const startedAt = performance.now();
  const { counts, authorIds, completedAt } = o.dryRun
    ? await dryRun(pool, organizationId, subjects, o)
    : await execute(pool, organizationId, subjects, o);
  const found = authorIds.length > 0 || counts.ruleEntriesRemoved + counts.ruleEntriesKept > 0;
  o.log.info('privacy.erasure_done', {
    organizationId,
    dryRun: o.dryRun,
    found,
    ...counts,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return { found, counts, coverage: 'all_ingested_before_completed_at', completedAt };
}
