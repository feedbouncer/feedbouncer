import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { ZipFile } from 'yazl';
import { withTransaction } from '@feedbouncer/db';
import { UUID } from '@feedbouncer/jobs';
import { authorRules, entryMatches, findAuthorEntries } from '../erase/rule-entries.js';
import { FINISHED_JOB_STATES } from '../purge/categories.js';
import type { SubjectIdentifierT } from '../subject/identifier.js';
import { locateAuthorIds } from '../subject/locate.js';
import { jsonArrayStream } from './json-array-stream.js';

export const EXPORT_MEMBERS = [
  'authors',
  'comments',
  'decisions',
  'review_items',
  'moderation_actions',
  'policy_previews',
  'rule_entries',
  'operational',
] as const;
export type ExportMember = (typeof EXPORT_MEMBERS)[number];

export const EXPORT_NOT_INCLUDED = [
  'Data held by the source platform or by third-party AI providers.',
  'Other identities of this person that were not supplied as identifiers.',
  'Copies in backups or replicas managed by the operator.',
] as const;

export interface ExportResult {
  found: boolean;
  counts: Record<ExportMember, number>;
  bytes: number;
  sha256: Buffer;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Pages through `sql` in order of its `id` column (a unique uuid), `pageSize` rows per query.
 * The cursor and the page size are bound after `params`.
 */
export async function* cursorRows<T extends { id: string }>(
  c: pg.PoolClient,
  sql: string,
  params: unknown[],
  pageSize = 500,
): AsyncIterable<T> {
  const paged = `SELECT * FROM (${sql}) page WHERE page.id > $${params.length + 1}::uuid
    ORDER BY page.id LIMIT $${params.length + 2}`;
  let after = NIL_UUID;
  for (;;) {
    const { rows } = await c.query<T>(paged, [...params, after, pageSize]);
    yield* rows;
    if (rows.length < pageSize) return;
    after = rows.at(-1)!.id;
  }
}

async function* mapRows<T, U>(rows: AsyncIterable<T>, fn: (row: T) => U): AsyncIterable<U> {
  for await (const row of rows) yield fn(row);
}

async function* concat<T>(...parts: AsyncIterable<T>[]): AsyncIterable<T> {
  for (const part of parts) yield* part;
}

/** The subject's comments: $1 organization, $2 matched author ids. */
const SUBJECT_COMMENTS = `SELECT id FROM comment WHERE organization_id = $1 AND author_id = ANY($2::uuid[])`;
const OF_SUBJECT = `organization_id = $1 AND comment_id IN (${SUBJECT_COMMENTS})`;

interface AuthorRow {
  id: string;
  platform: string;
  connection_id: string;
  external_id: string;
  display_name: string | null;
  created_at: Date;
}

interface CommentRow {
  id: string;
  platform: string;
  connection_id: string;
  external_id: string;
  permalink: string | null;
  body: string;
  posted_at: Date;
  ingested_at: Date;
  platform_state: string;
  parent_comment_id: string | null;
  is_reply: boolean;
  parent_removed: boolean;
}

interface DecisionRow {
  id: string;
  comment_id: string;
  outcome: string;
  mode: string;
  actor_type: string;
  rule_id: string | null;
  category: string | null;
  confidence: string | null;
  reason: string;
  created_at: Date;
}

interface ScoresRow {
  id: string;
  comment_id: string;
  scores: unknown;
  created_at: Date;
}

interface PolicyRow {
  id: string;
  comment_id: string;
  outcome: string | null;
  created_at: Date;
}

interface ReviewRow {
  id: string;
  comment_id: string;
  status: string;
  resolution: string | null;
  source: string;
  created_at: Date;
  resolved_at: Date | null;
}

interface ModerationRow {
  id: string;
  comment_id: string;
  kind: string;
  status: string;
  reply_text: string | null;
  created_at: Date;
  completed_at: Date | null;
}

interface PreviewRow {
  id: string;
  comment_id: string;
  preview_id: string;
  verdict: string | null;
  proposed_action: string | null;
  reason: string | null;
  created_at: Date;
}

interface LedgerRow {
  id: string;
  job_type: string;
  state: string;
  created_at: Date;
}

/**
 * The rows of each member. Every query reaches the data through the matched author ids or
 * their comment ids, so another person's comment, reply, id or name is never selected; a
 * reply to someone else carries only the parent's comment id.
 */
function memberRows(
  c: pg.PoolClient,
  organizationId: string,
  authorIds: readonly string[],
  subjects: readonly SubjectIdentifierT[],
): Record<ExportMember, () => AsyncIterable<unknown>> {
  const rows = <T extends { id: string }>(sql: string, extra: unknown[] = []) =>
    cursorRows<T>(c, sql, [organizationId, authorIds, ...extra]);
  return {
    authors: () =>
      mapRows(
        rows<AuthorRow>(
          `SELECT a.id, k.platform, a.connection_id, a.external_id, a.display_name, a.created_at
             FROM author a JOIN connection k ON k.id = a.connection_id
            WHERE a.organization_id = $1 AND a.id = ANY($2::uuid[])`,
        ),
        (r) => ({
          platform: r.platform,
          connectionId: r.connection_id,
          externalId: r.external_id,
          displayName: r.display_name,
          firstSeenAt: r.created_at,
        }),
      ),
    comments: () =>
      mapRows(
        rows<CommentRow>(
          `SELECT c.id, k.platform, c.connection_id, c.external_id, c.permalink, c.body, c.posted_at,
                  c.ingested_at, c.platform_state, c.parent_comment_id,
                  (c.parent_comment_id IS NOT NULL OR c.parent_external_id IS NOT NULL
                    OR c.parent_removed_at IS NOT NULL) AS is_reply,
                  (c.parent_removed_at IS NOT NULL) AS parent_removed
             FROM comment c JOIN connection k ON k.id = c.connection_id
            WHERE c.organization_id = $1 AND c.author_id = ANY($2::uuid[])`,
        ),
        (r) => ({
          id: r.id,
          platform: r.platform,
          connectionId: r.connection_id,
          externalId: r.external_id,
          permalink: r.permalink,
          body: r.body,
          postedAt: r.posted_at,
          ingestedAt: r.ingested_at,
          platformState: r.platform_state,
          inReplyTo: r.is_reply
            ? { commentId: r.parent_comment_id, removed: r.parent_removed }
            : null,
        }),
      ),
    decisions: () =>
      concat<unknown>(
        mapRows(
          rows<DecisionRow>(
            `SELECT id, comment_id, outcome, mode, actor_type, rule_id, category, confidence, reason,
                    created_at
               FROM decision WHERE ${OF_SUBJECT}`,
          ),
          (r) => ({
            kind: 'decision',
            commentId: r.comment_id,
            outcome: r.outcome,
            mode: r.mode,
            actorType: r.actor_type,
            ruleId: r.rule_id,
            category: r.category,
            confidence: r.confidence === null ? null : Number(r.confidence),
            reason: r.reason,
            createdAt: r.created_at,
          }),
        ),
        mapRows(
          rows<ScoresRow>(
            `SELECT id, comment_id, scores, created_at FROM comment_classification
              WHERE ${OF_SUBJECT} AND scores IS NOT NULL`,
          ),
          (r) => ({
            kind: 'classifier_scores',
            commentId: r.comment_id,
            scores: r.scores,
            createdAt: r.created_at,
          }),
        ),
        mapRows(
          rows<PolicyRow>(
            `SELECT id, comment_id, outcome, created_at FROM policy_evaluation WHERE ${OF_SUBJECT}`,
          ),
          (r) => ({
            kind: 'policy_evaluation',
            commentId: r.comment_id,
            outcome: r.outcome,
            createdAt: r.created_at,
          }),
        ),
      ),
    review_items: () =>
      mapRows(
        rows<ReviewRow>(
          `SELECT id, comment_id, status, resolution, source, created_at, resolved_at
             FROM review_item WHERE ${OF_SUBJECT}`,
        ),
        (r) => ({
          commentId: r.comment_id,
          status: r.status,
          resolution: r.resolution,
          source: r.source,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at,
        }),
      ),
    moderation_actions: () =>
      mapRows(
        rows<ModerationRow>(
          `SELECT id, comment_id, kind, status, reply_text, created_at, completed_at
             FROM moderation_action WHERE ${OF_SUBJECT}`,
        ),
        (r) => ({
          commentId: r.comment_id,
          kind: r.kind,
          status: r.status,
          replyText: r.reply_text,
          createdAt: r.created_at,
          completedAt: r.completed_at,
        }),
      ),
    policy_previews: () =>
      mapRows(
        rows<PreviewRow>(
          `SELECT id, comment_id, preview_id, verdict, proposed_action, reason, created_at
             FROM policy_preview_result WHERE ${OF_SUBJECT}`,
        ),
        (r) => ({
          commentId: r.comment_id,
          previewId: r.preview_id,
          verdict: r.verdict,
          proposedAction: r.proposed_action,
          reason: r.reason,
          createdAt: r.created_at,
        }),
      ),
    rule_entries: () => ruleEntries(c, organizationId, subjects),
    operational: () =>
      mapRows(
        rows<LedgerRow>(
          `SELECT x.id, x.job_type, x.state, x.created_at FROM job_ledger x
            WHERE x.organization_id = $1 AND x.state = ANY($3::text[]) AND EXISTS (
              SELECT 1 FROM comment c
               WHERE c.organization_id = $1 AND c.author_id = ANY($2::uuid[])
                 AND c.connection_id = x.connection_id
                 AND jsonb_path_exists(x.payload, '$.** ? (@ == $v)',
                                       jsonb_build_object('v', c.external_id)))`,
          [FINISHED_JOB_STATES],
        ),
        (r) => ({ jobType: r.job_type, state: r.state, createdAt: r.created_at }),
      ),
  };
}

async function* ruleEntries(
  c: pg.PoolClient,
  organizationId: string,
  subjects: readonly SubjectIdentifierT[],
): AsyncIterable<unknown> {
  const matches = entryMatches(subjects);
  for (const rule of await authorRules(c, organizationId)) {
    for (const entry of findAuthorEntries(rule.conditions, matches))
      yield { ruleId: rule.id, ruleName: rule.name, ...entry };
  }
}

async function* counted<T>(rows: AsyncIterable<T>, onRow: () => void): AsyncIterable<T> {
  for await (const row of rows) {
    onRow();
    yield row;
  }
}

interface ArchiveInput {
  organizationId: string;
  requestId: string;
  subjects: readonly SubjectIdentifierT[];
  generatedAt: Date;
}

/** Streams the archive into `file` from one snapshot; the manifest goes last, with the counts. */
async function writeArchive(
  c: pg.PoolClient,
  sink: Writable,
  input: ArchiveInput,
): Promise<ExportResult> {
  const { organizationId, requestId, subjects, generatedAt } = input;
  const authorIds = await locateAuthorIds(c, organizationId, subjects);
  const sources = memberRows(c, organizationId, authorIds, subjects);
  const counts = Object.fromEntries(EXPORT_MEMBERS.map((m) => [m, 0])) as Record<
    ExportMember,
    number
  >;
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const fail = (err: Error) => output.destroy(err);
  zip.on('error', fail);

  const writeManifest = () => {
    const manifest = {
      format: 'feedbouncer.subject-export',
      version: 1,
      requestId,
      organizationId,
      generatedAt: generatedAt.toISOString(),
      coverage: 'snapshot_at_generated_at',
      subjects,
      counts,
      notIncluded: EXPORT_NOT_INCLUDED,
    };
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 'manifest.json', {
      mtime: generatedAt,
    });
    zip.end();
  };

  EXPORT_MEMBERS.forEach((member, i) => {
    zip.addReadStreamLazy(`${member}.json`, { mtime: generatedAt }, (cb) => {
      const stream = jsonArrayStream(counted(sources[member](), () => (counts[member] += 1)));
      stream.once('error', fail);
      if (i === EXPORT_MEMBERS.length - 1) stream.once('end', writeManifest);
      cb(null, stream);
    });
  });

  const hash = createHash('sha256');
  let bytes = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(output, measure, sink);
  const found = authorIds.length > 0 || counts.rule_entries > 0;
  return { found, counts, bytes, sha256: hash.digest() };
}

async function assertAbsent(file: string): Promise<void> {
  try {
    await stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  throw Object.assign(new Error('export file already exists'), { code: 'EEXIST' });
}

/**
 * Writes one subject's data in one organization as `<dir>/<requestId>.zip` (mode 0600): a
 * consistent snapshot read in one repeatable-read, read-only transaction and streamed member
 * by member, so memory stays flat however long the history. The file is written as `.part`
 * (never over an existing file), synced, then renamed; on failure the partial file is removed.
 */
export async function writeSubjectExport(
  pool: pg.Pool,
  organizationId: string,
  requestId: string,
  subjects: SubjectIdentifierT[],
  o: { dir: string; now?: () => Date },
): Promise<ExportResult> {
  if (!UUID.test(requestId)) throw new TypeError('invalid request id');
  const target = path.join(o.dir, `${requestId}.zip`);
  const part = `${target}.part`;
  await assertAbsent(target);
  await (await open(part, 'wx', 0o600)).close();
  try {
    const generatedAt = (o.now ?? (() => new Date()))();
    const result = await withTransaction(
      pool,
      (c) =>
        writeArchive(c, createWriteStream(part), {
          organizationId,
          requestId,
          subjects,
          generatedAt,
        }),
      { isolation: 'repeatable read', readOnly: true },
    );
    const written = await open(part, 'r');
    await written.sync().finally(() => written.close());
    await rename(part, target);
    return result;
  } catch (err) {
    await unlink(part).catch(() => {});
    throw err;
  }
}
