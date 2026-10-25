import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { PgCommentStore } from '@feedbouncer/comments';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { Logger } from '@feedbouncer/service-runtime';
import {
  loadRetentionSettings,
  type RetentionCategory,
  type RetentionDays,
  type RetentionSettings,
} from '../settings.js';
import { publishRetentionStatus } from '../status.js';
import { confirmRetention, previewPurge, runPurge } from './purge.js';

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const MARKER = 'BODY-MARKER-7f3c';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'privacy-purge-test', onIdleError: () => {} });
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

beforeEach(async () => {
  await ctx.c.query('DELETE FROM organization');
  await ctx.c.query('DELETE FROM retention_run');
  await ctx.c.query('DELETE FROM retention_confirmation');
  A = await seedTenant(ctx.c, 'a');
  B = await seedTenant(ctx.c, 'b');
});

const forever = loadRetentionSettings({});
const settings = (
  days: Partial<Record<RetentionCategory, RetentionDays>>,
  o: Partial<Omit<RetentionSettings, 'days'>> = {},
): RetentionSettings => ({ ...forever, ...o, days: { ...forever.days, ...days } });

interface Captured {
  msg: string;
  fields: Record<string, unknown>;
}
function recorder(): Logger & { lines: Captured[] } {
  const lines: Captured[] = [];
  const push = (msg: string, fields?: Record<string, unknown>) =>
    lines.push({ msg, fields: fields ?? {} });
  return { lines, debug: push, info: push, warn: push, error: push };
}

const purge = (s: RetentionSettings, o: { deadlineMs?: number; log?: Logger } = {}) =>
  runPurge(pool, s, { log: o.log ?? recorder(), now: () => NOW, ...o });

const one = async (sql: string, v: unknown[] = []) =>
  (await ctx.c.query<{ id: string }>(sql, v)).rows[0]!.id;

const count = async (sql: string, v: unknown[] = []) =>
  Number((await ctx.c.query<{ n: string }>(sql, v)).rows[0]!.n);

const exists = async (table: string, id: string) =>
  (await count(`SELECT count(*) AS n FROM ${table} WHERE id = $1`, [id])) === 1;

async function author(t: Tenant, externalId: string): Promise<string> {
  return one(
    `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
     VALUES ($1, $2, $3, $4, 'Someone') RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, externalId],
  );
}

async function comment(
  t: Tenant,
  ageDays: number,
  o: { authorId?: string; parent?: { id: string; externalId: string } } = {},
): Promise<{ id: string; externalId: string }> {
  const externalId = `c-${randomUUID()}`;
  const id = await one(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                          parent_comment_id, parent_external_id, body, posted_at, ingested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      t.sourceId,
      externalId,
      o.authorId ?? t.authorId,
      o.parent?.id ?? null,
      o.parent?.externalId ?? null,
      `${MARKER} body`,
      ago(ageDays),
    ],
  );
  return { id, externalId };
}

async function comments(t: Tenant, n: number, ageDays: number): Promise<void> {
  await ctx.c.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                          body, posted_at, ingested_at)
     SELECT $1, $2, $3, $4, 'bulk-' || gen_random_uuid(), $5, 'bulk', $6, $6 FROM generate_series(1, $7)`,
    [t.organizationId, t.brandId, t.connectionId, t.sourceId, t.authorId, ago(ageDays), n],
  );
}

async function ruleEvaluation(t: Tenant, commentId: string, ageDays: number): Promise<string> {
  return one(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                  trigger_key, ruleset_version, status, created_at)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'v1', 'no_match', $5)
     RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, commentId, ago(ageDays)],
  );
}

async function decision(
  t: Tenant,
  commentId: string,
  ageDays: number,
  ruleEvaluationId: string | null = null,
): Promise<string> {
  return one(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
                           rule_evaluation_id, reason, created_at)
     VALUES ($1, $2, $3, 'approve', 'enforce', 'rule', $4, $5, 'Seeded.', $6) RETURNING id`,
    [t.organizationId, t.brandId, commentId, t.ruleId, ruleEvaluationId, ago(ageDays)],
  );
}

async function reviewItem(
  t: Tenant,
  commentId: string,
  o: { resolvedDaysAgo?: number } = {},
): Promise<string> {
  const resolved = o.resolvedDaysAgo !== undefined;
  return one(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, status,
                              resolution, resolved_at)
     VALUES ($1, $2, $3, $4, 'user', $5, $6, $7) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      commentId,
      resolved ? 'resolved' : 'open',
      resolved ? 'approved' : null,
      resolved ? ago(o.resolvedDaysAgo!) : null,
    ],
  );
}

const resolveReview = (id: string) =>
  ctx.c.query(
    `UPDATE review_item SET status = 'resolved', resolution = 'approved', resolved_at = $2
      WHERE id = $1`,
    [id, ago(40)],
  );

async function suggestion(t: Tenant, commentId: string): Promise<string> {
  return one(
    `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256, status)
     VALUES ($1, $2, $3, $4, decode(repeat('cd', 32), 'hex'), 'pending') RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, commentId],
  );
}

async function previewResult(t: Tenant, commentId: string, ageDays = 1): Promise<string> {
  const previewId = await one(
    `INSERT INTO policy_preview (organization_id, brand_id, text, action, days, since, total, capped,
                                 status, completed_at, created_at)
     VALUES ($1, $2, 'No spam links please', 'hide', 7, $3, 1, false, 'done', $3, $3) RETURNING id`,
    [t.organizationId, t.brandId, ago(ageDays)],
  );
  await ctx.c.query(
    `INSERT INTO policy_preview_result (organization_id, brand_id, preview_id, connection_id, comment_id, position)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [t.organizationId, t.brandId, previewId, t.connectionId, commentId],
  );
  return previewId;
}

async function tag(t: Tenant, commentId: string): Promise<void> {
  const tagId = await one(
    'INSERT INTO tag (organization_id, name, name_key) VALUES ($1, $2, $2) RETURNING id',
    [t.organizationId, `tag-${randomUUID()}`],
  );
  await ctx.c.query(
    'INSERT INTO comment_tag (organization_id, brand_id, comment_id, tag_id) VALUES ($1, $2, $3, $4)',
    [t.organizationId, t.brandId, commentId, tagId],
  );
}

async function ledger(
  t: Tenant,
  state: 'completed' | 'queued' | 'dead_lettered',
  ageDays: number,
): Promise<string> {
  return one(
    `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
                             payload, state, completed_at, dead_letter_reason, dead_lettered_at,
                             expires_at, created_at)
     VALUES ($1, $2, $3, 'facebook', 'ingest_comment', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
             '{}', $4::text, CASE WHEN $4::text = 'completed' THEN $5::timestamptz END,
             CASE WHEN $4::text = 'dead_lettered' THEN 'retries_exhausted' END,
             CASE WHEN $4::text = 'dead_lettered' THEN $5::timestamptz END, $6, $5)
     RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, state, ago(ageDays), ago(-30)],
  );
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const publicId = () =>
  Array.from({ length: 16 }, () => BASE32[Math.floor(Math.random() * 32)]).join('');

async function idempotencyRecord(t: Tenant, ageDays: number): Promise<string> {
  const keyId = await one(
    `INSERT INTO api_key (organization_id, name, public_id, secret_sha256, scope)
     VALUES ($1, 'k', $2, decode(repeat('ef', 32), 'hex'), 'read') RETURNING id`,
    [t.organizationId, publicId()],
  );
  return one(
    `INSERT INTO api_idempotency_record (organization_id, api_key_id, idempotency_key, request_sha256,
                                         state, expires_at, created_at)
     VALUES ($1, $2, 'key-1', decode(repeat('01', 32), 'hex'), 'completed', $3, $4) RETURNING id`,
    [t.organizationId, keyId, ago(-30), ago(ageDays)],
  );
}

async function auditEvent(t: Tenant, ageDays: number): Promise<string> {
  return one(
    `INSERT INTO audit_event (organization_id, actor_type, action, subject_type, subject_id, created_at)
     VALUES ($1, 'system', 'seeded.event', 'organization', $1, $2) RETURNING id`,
    [t.organizationId, ago(ageDays)],
  );
}

const retentionAudits = async (organizationId: string, action: string) =>
  (
    await ctx.c.query<{ details: Record<string, unknown>; actor_type: string; subject_id: string }>(
      `SELECT details, actor_type, subject_id FROM audit_event
        WHERE organization_id = $1 AND action = $2 ORDER BY sequence`,
      [organizationId, action],
    )
  ).rows;

const TABLES = [
  'comment',
  'author',
  'decision',
  'rule_evaluation',
  'review_item',
  'comment_tag',
  'policy_preview',
  'policy_preview_result',
  'job_ledger',
  'api_idempotency_record',
  'audit_event',
];
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(
      TABLES.map(async (t) => [t, await count(`SELECT count(*) AS n FROM ${t}`)] as const),
    ),
  );

async function fullComment(t: Tenant, ageDays: number) {
  const c = await comment(t, ageDays);
  const evaluation = await ruleEvaluation(t, c.id, ageDays);
  await decision(t, c.id, ageDays, evaluation);
  await reviewItem(t, c.id, { resolvedDaysAgo: ageDays });
  await tag(t, c.id);
  await previewResult(t, c.id);
  return c;
}

describe('runPurge', () => {
  it('deletes nothing when every category is kept forever', async () => {
    await fullComment(A, 400);
    await previewResult(A, (await comment(A, 400)).id, 8);
    await ledger(A, 'completed', 400);
    await idempotencyRecord(A, 400);
    await auditEvent(A, 400);
    const before = await snapshot();

    const r = await purge(forever);

    expect(r.status).toBe('done');
    expect(Object.values(r.counts.byCategory).every((n) => n === 0)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('deletes comments past the period with everything that hangs off them', async () => {
    const old = await fullComment(A, 31);
    const recent = await fullComment(A, 29);

    const r = await purge(settings({ comments: 30 }));

    expect(r.counts.byCategory.comments).toBe(1);
    expect(await exists('comment', old.id)).toBe(false);
    expect(await exists('comment', recent.id)).toBe(true);
    for (const table of [
      'decision',
      'rule_evaluation',
      'review_item',
      'comment_tag',
      'policy_preview_result',
    ]) {
      expect(
        await count(`SELECT count(*) AS n FROM ${table} WHERE comment_id = $1`, [old.id]),
      ).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM ${table} WHERE comment_id = $1`, [recent.id]),
      ).toBe(1);
    }
  });

  it('also removes the YouTube thread rows and batch ids of purged comments', async () => {
    const old = await comment(A, 31);
    const recent = await comment(A, 29);
    for (const c of [old, recent])
      await ctx.c.query(
        `INSERT INTO youtube_thread (organization_id, brand_id, connection_id, thread_external_id,
                                     video_external_id, reply_count, last_activity_at)
         VALUES ($1, $2, $3, $4, 'video', 0, now())`,
        [A.organizationId, A.brandId, A.connectionId, c.externalId],
      );
    const batch = await one(
      `INSERT INTO youtube_write_batch (organization_id, brand_id, connection_id, pacific_day,
                                        moderation_status, ban_author, comment_external_ids, action_ids, state)
       VALUES ($1, $2, $3, '2026-10-24', 'rejected', false, $4, '{}', 'confirmed') RETURNING id`,
      [A.organizationId, A.brandId, A.connectionId, [old.externalId, recent.externalId]],
    );

    await purge(settings({ comments: 30 }));

    const threads = await ctx.c.query<{ thread_external_id: string }>(
      'SELECT thread_external_id FROM youtube_thread WHERE connection_id = $1',
      [A.connectionId],
    );
    expect(threads.rows.map((r) => r.thread_external_id)).toEqual([recent.externalId]);
    const ids = await ctx.c.query<{ comment_external_ids: string[] }>(
      'SELECT comment_external_ids FROM youtube_write_batch WHERE id = $1',
      [batch],
    );
    expect(ids.rows[0]!.comment_external_ids).toEqual([recent.externalId]);
  });

  it('fingerprints purged comments so a later poll cannot ingest them again', async () => {
    const old = await comment(A, 31);
    const recent = await comment(A, 29);

    await purge(settings({ comments: 30 }));

    const normalized = (externalId: string) => ({
      externalId,
      sourceExternalId: 'post-1',
      parentExternalId: null,
      author: { externalId: 'u-again', displayName: 'Ann', profileUrl: null },
      body: 'again',
      postedAt: NOW,
      platformState: 'visible' as const,
      permalink: null,
    });
    const scope = {
      organizationId: A.organizationId,
      brandId: A.brandId,
      connectionId: A.connectionId,
    };
    const opts = { ownAccountExternalId: 'page', syncedAt: NOW };
    const store = new PgCommentStore(pool);
    expect(await store.upsertFromPlatform(scope, normalized(old.externalId), opts)).toEqual({
      suppressed: true,
    });
    expect(await exists('comment', old.id)).toBe(false);
    expect(await count('SELECT count(*) AS n FROM erased_comment')).toBe(1);
    expect(
      (await store.upsertFromPlatform(scope, normalized(recent.externalId), opts)).suppressed,
    ).toBe(false);
  });

  it('keeps a recent reply to a purged parent and marks the parent as removed', async () => {
    const x = await author(A, 'psid-x');
    const y = await author(A, 'psid-y');
    const parent = await comment(A, 31, { authorId: x });
    const reply = await comment(A, 1, { authorId: y, parent });

    await purge(settings({ comments: 30 }));

    expect(await exists('comment', parent.id)).toBe(false);
    const { rows } = await ctx.c.query(
      `SELECT parent_comment_id, parent_external_id, parent_removed_at, body, author_id
         FROM comment WHERE id = $1`,
      [reply.id],
    );
    expect(rows[0]).toMatchObject({
      parent_comment_id: null,
      parent_external_id: null,
      body: `${MARKER} body`,
      author_id: y,
    });
    expect(rows[0].parent_removed_at).toBeInstanceOf(Date);
  });

  it('also marks a reply linked to the purged parent only by its external id', async () => {
    const parent = await comment(A, 31);
    const reply = await comment(A, 1);
    await ctx.c.query('UPDATE comment SET parent_external_id = $2 WHERE id = $1', [
      reply.id,
      parent.externalId,
    ]);

    await purge(settings({ comments: 30 }));

    expect(await exists('comment', parent.id)).toBe(false);
    const { rows } = await ctx.c.query(
      'SELECT parent_comment_id, parent_external_id, parent_removed_at FROM comment WHERE id = $1',
      [reply.id],
    );
    expect(rows[0]).toMatchObject({ parent_comment_id: null, parent_external_id: null });
    expect(rows[0].parent_removed_at).toBeInstanceOf(Date);
  });

  it('deletes authors left without comments once they are past the period', async () => {
    const gone = await author(A, 'psid-gone');
    const stays = await author(A, 'psid-stays');
    // The updated_at trigger would overwrite the backdated value.
    await ctx.c.query('ALTER TABLE author DISABLE TRIGGER USER');
    try {
      await ctx.c.query('UPDATE author SET updated_at = $2 WHERE id = ANY($1::uuid[])', [
        [gone, stays],
        ago(31),
      ]);
    } finally {
      await ctx.c.query('ALTER TABLE author ENABLE TRIGGER USER');
    }
    await comment(A, 31, { authorId: gone });
    await comment(A, 1, { authorId: stays });

    await purge(settings({ comments: 30 }));

    expect(await exists('author', gone)).toBe(false);
    expect(await exists('author', stays)).toBe(true);
    expect(await exists('author', A.authorId)).toBe(true);
  });

  it('keeps comments waiting in the review queue until they are resolved', async () => {
    const c = await comment(A, 31);
    const item = await reviewItem(A, c.id);

    const first = await purge(settings({ comments: 30 }));
    expect(await exists('comment', c.id)).toBe(true);
    expect(first.counts.skippedPendingReview).toBe(1);
    expect(first.counts.byCategory.comments).toBe(0);

    await resolveReview(item);
    const second = await purge(settings({ comments: 30 }));
    expect(await exists('comment', c.id)).toBe(false);
    expect(second.counts.skippedPendingReview).toBe(0);
  });

  it('keeps comments with a pending suggestion until it is decided', async () => {
    const c = await comment(A, 31);
    const s = await suggestion(A, c.id);

    const first = await purge(settings({ comments: 30 }));
    expect(await exists('comment', c.id)).toBe(true);
    expect(first.counts.skippedPendingReview).toBe(1);

    await ctx.c.query(
      "UPDATE action_suggestion SET status = 'dismissed', decided_at = now() WHERE id = $1",
      [s],
    );
    await purge(settings({ comments: 30 }));
    expect(await exists('comment', c.id)).toBe(false);
  });

  it('deletes old decisions but keeps the comment, unfinished actions and queued items', async () => {
    const c = await comment(A, 400);
    const evaluation = await ruleEvaluation(A, c.id, 11);
    const d = await decision(A, c.id, 11, evaluation);
    const fresh = await decision(A, c.id, 9);
    const action = await one(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, actor_user_id, request_key, status, created_at)
       VALUES ($1, $2, $3, $4, 'hide', 'user', $5, $6, 'pending', $7) RETURNING id`,
      [A.organizationId, A.brandId, A.connectionId, c.id, A.userId, `k-${randomUUID()}`, ago(11)],
    );
    const queued = await comment(A, 400);
    await reviewItem(A, queued.id);
    const queuedDecision = await decision(A, queued.id, 11);

    const r = await purge(settings({ decisions: 10 }));

    expect(await exists('decision', d)).toBe(false);
    expect(await exists('rule_evaluation', evaluation)).toBe(false);
    expect(await exists('decision', fresh)).toBe(true);
    expect(await exists('comment', c.id)).toBe(true);
    expect(await exists('moderation_action', action)).toBe(true);
    expect(await exists('decision', queuedDecision)).toBe(true);
    expect(r.counts.byCategory.decisions).toBe(2);
    expect(r.counts.skippedPendingReview).toBe(1);
  });

  it('deletes finished operational records and never queued or replayable jobs', async () => {
    const done = await ledger(A, 'completed', 2);
    const queued = await ledger(A, 'queued', 2);
    const deadLettered = await ledger(A, 'dead_lettered', 2);
    const idem = await idempotencyRecord(A, 2);

    const r = await purge(settings({ operational: 1 }));

    expect(await exists('job_ledger', done)).toBe(false);
    expect(await exists('job_ledger', queued)).toBe(true);
    expect(await exists('job_ledger', deadLettered)).toBe(true);
    expect(await exists('api_idempotency_record', idem)).toBe(false);
    expect(r.counts.byCategory.operational).toBe(2);
  });

  it('applies built-in limits per operational table, never lengthening them', async () => {
    const job = await ledger(A, 'completed', 2);
    const idem = await idempotencyRecord(A, 2);

    await purge(settings({ operational: 5 }));

    expect(await exists('job_ledger', job)).toBe(true);
    expect(await exists('api_idempotency_record', idem)).toBe(false);
  });

  it('caps previews at their built-in period', async () => {
    const c = await comment(A, 1);
    const old = await previewResult(A, c.id, 8);
    const recent = await previewResult(A, c.id, 6);

    const r = await purge(settings({ previews: 30 }));

    expect(await exists('policy_preview', old)).toBe(false);
    expect(await exists('policy_preview', recent)).toBe(true);
    expect(await count('SELECT count(*) AS n FROM policy_preview_result')).toBe(1);
    expect(r.counts.byCategory.previews).toBe(1);
  });

  it('deletes audit events past the period', async () => {
    const old = await auditEvent(A, 31);
    const recent = await auditEvent(A, 29);

    await purge(settings({ audit: 30 }));

    expect(await exists('audit_event', old)).toBe(false);
    expect(await exists('audit_event', recent)).toBe(true);
  });

  it('works in batches, one transaction each', async () => {
    await comments(A, 250, 31);
    const log = recorder();

    const r = await purge(settings({ comments: 30 }, { batchSize: 100 }), { log });

    expect(r.counts.byCategory.comments).toBe(250);
    const batches = log.lines.filter(
      (l) => l.msg === 'retention.batch' && l.fields.table === 'comment',
    );
    expect(batches.length).toBeGreaterThanOrEqual(3);
  });

  it('stops at the deadline and the next run finishes the work', async () => {
    // Organizations are walked in id order and a zero deadline stops after the first table,
    // so the data goes to the organization that is walked first.
    const T = A.organizationId < B.organizationId ? A : B;
    await comments(T, 250, 31);
    for (const c of (await ctx.c.query<{ id: string }>('SELECT id FROM comment')).rows)
      await decision(T, c.id, 31);
    const s = settings({ comments: 30 }, { batchSize: 100 });

    const first = await purge(s, { deadlineMs: 0 });
    expect(first.status).toBe('partial');
    expect(first.counts.byCategory.comments).toBe(100);

    const second = await purge(s);
    expect(second.status).toBe('done');
    expect(second.counts.byCategory.comments).toBe(150);
    expect(
      await count(
        'SELECT count(*) AS n FROM decision d LEFT JOIN comment c ON c.id = d.comment_id WHERE c.id IS NULL',
      ),
    ).toBe(0);
  });

  it('holds a large deletion until it is confirmed', async () => {
    await comments(A, 11, 31);
    const s = settings({ comments: 30 }, { confirmAbove: 10 });

    const preview = await previewPurge(pool, s, NOW);
    expect(preview.comments).toMatchObject({
      days: 30,
      eligible: 11,
      confirmed: false,
      wouldHold: true,
    });
    expect(preview.audit).toMatchObject({ days: 'forever', eligible: 0, wouldHold: false });

    const held = await purge(s);
    expect(held.held).toEqual(['comments']);
    expect(held.counts.byCategory.comments).toBe(0);
    expect(await count('SELECT count(*) AS n FROM comment')).toBe(11);
    const audits = await retentionAudits(A.organizationId, 'retention.held');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: 'system',
      subject_id: held.runId,
      details: { runId: held.runId, category: 'comments', days: 30 },
    });
    expect(await retentionAudits(B.organizationId, 'retention.held')).toHaveLength(0);

    await expect(confirmRetention(pool, s, 'comments', 31, 'ops')).rejects.toThrow(
      'Setting for comments is 30, not 31; nothing confirmed.',
    );
    expect(await confirmRetention(pool, s, 'comments', 30, 'ops')).toEqual({ eligible: 11 });
    const confirmations = await retentionAudits(A.organizationId, 'retention.confirmed');
    expect(confirmations.map((e) => [e.actor_type, e.details])).toEqual([
      ['system', { category: 'comments', days: 30 }],
    ]);
    expect(await retentionAudits(B.organizationId, 'retention.confirmed')).toHaveLength(0);
    expect((await previewPurge(pool, s, NOW)).comments).toMatchObject({
      confirmed: true,
      wouldHold: false,
    });

    const confirmed = await purge(s);
    expect(confirmed.held).toEqual([]);
    expect(confirmed.counts.byCategory.comments).toBe(11);
  });

  it('forgets a confirmation once the setting has changed, even if it changes back', async () => {
    await comments(A, 11, 31);
    const at30 = settings({ comments: 30 }, { confirmAbove: 10 });
    const at60 = settings({ comments: 60 }, { confirmAbove: 10 });

    await confirmRetention(pool, at30, 'comments', 30, 'ops');
    await purge(at60);
    expect((await purge(at30)).held).toEqual(['comments']);

    await confirmRetention(pool, at30, 'comments', 30, 'ops');
    // A worker started with another setting publishes it before any run.
    await publishRetentionStatus(pool, at60);
    expect((await previewPurge(pool, at30, NOW)).comments.confirmed).toBe(false);
    expect((await purge(at30)).held).toEqual(['comments']);
    expect(await count('SELECT count(*) AS n FROM comment')).toBe(11);
  });

  it('forgets a confirmation when the category is kept forever in between', async () => {
    await comments(A, 11, 31);
    const at30 = settings({ comments: 30 }, { confirmAbove: 10 });

    await confirmRetention(pool, at30, 'comments', 30, 'ops');
    await publishRetentionStatus(pool, settings({}, { confirmAbove: 10 }));

    expect(await count('SELECT count(*) AS n FROM retention_confirmation')).toBe(0);
    expect((await purge(at30)).held).toEqual(['comments']);
    expect(await count('SELECT count(*) AS n FROM comment')).toBe(11);
  });

  it('keeps a comment whose webhook event still has a delivery in flight', async () => {
    const c = await comment(A, 40);
    const endpoint = await one(
      `INSERT INTO webhook_endpoint (organization_id, url, event_types, signing_key_id, encrypted_signing_secret)
       VALUES ($1, 'https://example.test/hook', ARRAY['comment.received'], 'k1', '\\x00') RETURNING id`,
      [A.organizationId],
    );
    const event = await one(
      `INSERT INTO webhook_event (organization_id, brand_id, type, dedupe_key, comment_id, occurred_at)
       VALUES ($1, $2, 'comment.received', $3, $4, $5) RETURNING id`,
      [A.organizationId, A.brandId, `seed:${c.id}`, c.id, ago(40)],
    );
    const delivery = await one(
      `INSERT INTO webhook_delivery (organization_id, endpoint_id, event_id, kind, status)
       VALUES ($1, $2, $3, 'event', 'retrying') RETURNING id`,
      [A.organizationId, endpoint, event],
    );
    const s = settings({ comments: 30 });

    const first = await purge(s);
    expect(first.counts.byCategory.comments).toBe(0);
    expect(first.counts.skippedPendingReview).toBe(1);
    expect(await exists('comment', c.id)).toBe(true);
    expect(await exists('webhook_event', event)).toBe(true);
    expect((await previewPurge(pool, s, NOW)).comments).toMatchObject({
      eligible: 0,
      skippedPendingReview: 1,
    });

    await ctx.c.query("UPDATE webhook_delivery SET status = 'succeeded' WHERE id = $1", [delivery]);
    const second = await purge(s);
    expect(second.counts.byCategory.comments).toBe(1);
    expect(await exists('comment', c.id)).toBe(false);
    expect(await exists('webhook_event', event)).toBe(false);
  });

  it('records a hold once per organization while the category stays unconfirmed', async () => {
    await comments(A, 11, 40);
    const s = settings({ comments: 30 }, { confirmAbove: 10 });

    await purge(s);
    await purge(s);
    expect(await retentionAudits(A.organizationId, 'retention.held')).toHaveLength(1);

    await purge(settings({ comments: 31 }, { confirmAbove: 10 }));
    expect(await retentionAudits(A.organizationId, 'retention.held')).toHaveLength(2);
  });

  it('attributes counts and audit events to each organization', async () => {
    await comments(A, 2, 31);
    await comments(B, 1, 31);

    const r = await purge(settings({ comments: 30 }));

    expect(r.counts.byOrganization).toEqual({
      [A.organizationId]: { comments: 2 },
      [B.organizationId]: { comments: 1 },
    });
    const a = await retentionAudits(A.organizationId, 'retention.purged');
    const b = await retentionAudits(B.organizationId, 'retention.purged');
    expect(a.map((e) => e.details)).toEqual([{ runId: r.runId, counts: { comments: 2 } }]);
    expect(b.map((e) => e.details)).toEqual([{ runId: r.runId, counts: { comments: 1 } }]);
    expect(a[0]).toMatchObject({ actor_type: 'system', subject_id: r.runId });
  });

  it('lets only one of two concurrent runs purge', async () => {
    await comments(A, 120, 31);
    await comments(B, 80, 31);
    const s = settings({ comments: 30 }, { batchSize: 100 });
    const logs = [recorder(), recorder()];

    const results = await Promise.all(logs.map((log) => purge(s, { log })));

    expect(results.filter((r) => r.status === 'skipped_locked')).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.counts.byCategory.comments, 0)).toBe(200);
    expect(
      logs.flatMap((l) => l.lines).filter((l) => l.msg === 'retention.skipped_locked'),
    ).toHaveLength(1);
    expect(await count('SELECT count(*) AS n FROM retention_run')).toBe(1);
  });

  it('records the run and keeps personal data out of audit events and logs', async () => {
    const x = await author(A, 'psid-secret-person');
    await comment(A, 31, { authorId: x });
    await comments(B, 3, 31);
    const log = recorder();

    await purge(settings({ comments: 30 }, { confirmAbove: 2 }), { log });
    await confirmRetention(pool, settings({ comments: 30 }), 'comments', 30, 'ops');
    const r = await purge(settings({ comments: 30 }, { confirmAbove: 2 }), { log });

    const { rows } = await ctx.c.query<{ details: unknown }>(
      "SELECT details FROM audit_event WHERE action LIKE 'retention.%'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const serialized = JSON.stringify([rows, log.lines]);
    expect(serialized).not.toContain(MARKER);
    expect(serialized).not.toContain('psid-secret-person');

    const run = await ctx.c.query(
      'SELECT status, counts, held, cutoffs, finished_at FROM retention_run WHERE id = $1',
      [r.runId],
    );
    expect(run.rows[0]).toMatchObject({ status: 'done', held: [], counts: { comments: 4 } });
    expect(run.rows[0].cutoffs.comments).toBe(ago(30).toISOString());
    expect(run.rows[0].finished_at).toBeInstanceOf(Date);
    expect(log.lines.some((l) => l.msg === 'retention.purge_done')).toBe(true);
  });
});

describe('export cleanup', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fb-exports-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const request = (t: Tenant, expiresAt: Date) =>
    one(
      `INSERT INTO privacy_request (organization_id, kind, mode, status, requested_via, actor_label,
                                    subject_count, export_sha256, export_bytes, export_expires_at, finished_at)
       VALUES ($1, 'export', 'execute', 'done', 'cli', 'ops', 1, decode(repeat('aa', 32), 'hex'), 10, $2, now())
       RETURNING id`,
      [t.organizationId, expiresAt],
    );

  it('deletes expired export files even when everything is kept forever', async () => {
    const expired = await request(A, ago(1));
    const live = await request(B, ago(-1));
    for (const id of [expired, live]) await writeFile(join(dir, `${id}.zip`), 'zip');

    await runPurge(pool, forever, { log: recorder(), now: () => NOW, exportDir: dir });

    expect(existsSync(join(dir, `${expired}.zip`))).toBe(false);
    expect(existsSync(join(dir, `${live}.zip`))).toBe(true);
    const { rows } = await ctx.c.query(
      'SELECT id, export_sha256, export_bytes, export_expires_at FROM privacy_request WHERE id = $1',
      [expired],
    );
    expect(rows[0]).toMatchObject({
      export_sha256: null,
      export_bytes: null,
      export_expires_at: null,
    });
    expect(await exists('privacy_request', live)).toBe(true);
  });
});
