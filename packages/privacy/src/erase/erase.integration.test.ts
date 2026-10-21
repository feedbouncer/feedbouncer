import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { PgReviewQueue } from '@feedbouncer/actions';
import { PgCommentStore } from '@feedbouncer/comments';
import { commentFingerprint, createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { Logger } from '@feedbouncer/service-runtime';
import type { SubjectIdentifierT } from '../subject/identifier.js';
import { locateAuthorIds } from '../subject/locate.js';
import { eraseSubject, type ErasureCounts, type ErasureResult } from './erase.js';

const X = 'X-psid-4411';
const HANDLE = 'xavier.handle';
const MARKER = 'ERASE-BODY-MARKER-91c2';
const NAME = 'Xavier Displayname';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let A: Tenant;
let B: Tenant;
/** A second facebook connection (and source) of org A's brand. */
let A2: { connectionId: string; sourceId: string };

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'privacy-erase-test', onIdleError: () => {} });
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const one = async (sql: string, v: unknown[] = []) =>
  (await ctx.c.query<{ id: string }>(sql, v)).rows[0]!.id;
const count = async (sql: string, v: unknown[] = []) =>
  Number((await ctx.c.query<{ n: string }>(sql, v)).rows[0]!.n);
const exists = async (table: string, id: string) =>
  (await count(`SELECT count(*) AS n FROM ${table} WHERE id = $1`, [id])) === 1;

beforeEach(async () => {
  await ctx.c.query('DELETE FROM organization');
  A = await seedTenant(ctx.c, 'a');
  B = await seedTenant(ctx.c, 'b');
  const connectionId = await one(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, 'facebook', 'page-a2') RETURNING id`,
    [A.organizationId, A.brandId],
  );
  const sourceId = await one(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'ad_post', 'post-a2-1') RETURNING id`,
    [A.organizationId, A.brandId, connectionId],
  );
  A2 = { connectionId, sourceId };
});

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

const fb = (externalId: string): SubjectIdentifierT => ({ platform: 'facebook', externalId });

function erase(
  organizationId: string,
  subjects: SubjectIdentifierT[],
  o: Partial<Parameters<typeof eraseSubject>[3]> = {},
): Promise<ErasureResult> {
  return eraseSubject(pool, organizationId, subjects, {
    dryRun: false,
    keepRuleEntries: null,
    batchSize: 100,
    log: recorder(),
    ...o,
  });
}

const ZERO: ErasureCounts = {
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
};

interface Conn {
  organizationId: string;
  brandId: string;
  connectionId: string;
  sourceId: string;
}
const connA = (): Conn => ({ ...A, connectionId: A.connectionId, sourceId: A.sourceId });
const connA2 = (): Conn => ({ ...A, ...A2 });
const connB = (): Conn => ({ ...B, connectionId: B.connectionId, sourceId: B.sourceId });

async function author(c: Conn, externalId: string): Promise<string> {
  return one(
    `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.organizationId, c.brandId, c.connectionId, externalId, NAME],
  );
}

async function comment(
  c: Conn,
  authorId: string | null,
  parent?: { id: string | null; externalId: string },
): Promise<{ id: string; externalId: string }> {
  const externalId = `c-${randomUUID()}`;
  const id = await one(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                          parent_comment_id, parent_external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING id`,
    [
      c.organizationId,
      c.brandId,
      c.connectionId,
      c.sourceId,
      externalId,
      authorId,
      parent?.id ?? null,
      parent?.externalId ?? null,
      `${MARKER} body`,
    ],
  );
  return { id, externalId };
}

async function webhook(t: Tenant, commentId: string) {
  const endpoint = await one(
    `INSERT INTO webhook_endpoint (organization_id, url, event_types, signing_key_id, encrypted_signing_secret)
     VALUES ($1, 'https://example.test/hook', ARRAY['comment.received'], 'k1', '\\x00') RETURNING id`,
    [t.organizationId],
  );
  const event = await one(
    `INSERT INTO webhook_event (organization_id, brand_id, type, dedupe_key, comment_id, occurred_at)
     VALUES ($1, $2, 'comment.received', $3, $4, now()) RETURNING id`,
    [t.organizationId, t.brandId, `seed:${commentId}`, commentId],
  );
  const delivery = await one(
    `INSERT INTO webhook_delivery (organization_id, endpoint_id, event_id, kind, status)
     VALUES ($1, $2, $3, 'event', 'pending') RETURNING id`,
    [t.organizationId, endpoint, event],
  );
  return { event, delivery };
}

/** Everything that hangs off one comment and cascades with it. */
async function children(t: Tenant, c: Conn, commentId: string) {
  const evaluation = await one(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                  trigger_key, ruleset_version, status)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'v1', 'no_match') RETURNING id`,
    [t.organizationId, t.brandId, c.connectionId, commentId],
  );
  const decision = await one(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
                           rule_evaluation_id, reason)
     VALUES ($1, $2, $3, 'approve', 'enforce', 'rule', $4, $5, 'Seeded.') RETURNING id`,
    [t.organizationId, t.brandId, commentId, t.ruleId, evaluation],
  );
  const review = await one(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, status)
     VALUES ($1, $2, $3, $4, 'user', 'open') RETURNING id`,
    [t.organizationId, t.brandId, c.connectionId, commentId],
  );
  const suggestion = await one(
    `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256, status)
     VALUES ($1, $2, $3, $4, decode(repeat('cd', 32), 'hex'), 'pending') RETURNING id`,
    [t.organizationId, t.brandId, c.connectionId, commentId],
  );
  const preview = await one(
    `INSERT INTO policy_preview (organization_id, brand_id, text, action, days, since, total, capped,
                                 status, completed_at)
     VALUES ($1, $2, 'No spam links please', 'hide', 7, now(), 1, false, 'done', now()) RETURNING id`,
    [t.organizationId, t.brandId],
  );
  const previewResult = await one(
    `INSERT INTO policy_preview_result (organization_id, brand_id, preview_id, connection_id, comment_id, position)
     VALUES ($1, $2, $3, $4, $5, 0) RETURNING id`,
    [t.organizationId, t.brandId, preview, c.connectionId, commentId],
  );
  const tagId = await one(
    'INSERT INTO tag (organization_id, name, name_key) VALUES ($1, $2, $2) RETURNING id',
    [t.organizationId, `tag-${randomUUID()}`],
  );
  await ctx.c.query(
    'INSERT INTO comment_tag (organization_id, brand_id, comment_id, tag_id) VALUES ($1, $2, $3, $4)',
    [t.organizationId, t.brandId, commentId, tagId],
  );
  const moderation = await one(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                    actor_type, actor_user_id, request_key, status)
     VALUES ($1, $2, $3, $4, 'hide', 'user', $5, $6, 'pending') RETURNING id`,
    [t.organizationId, t.brandId, c.connectionId, commentId, t.userId, `k-${randomUUID()}`],
  );
  const hook = await webhook(t, commentId);
  return { evaluation, decision, review, suggestion, preview, previewResult, moderation, ...hook };
}

/**
 * Org A: subject X on both connections (3 comments: c1, c2 = X's reply to Y's comment, c3).
 * Y replies to c1 by id and someone replies to c3 by external id only. Org B: the same
 * platform id X on B's connection.
 */
async function seedSubject() {
  const xa1 = await author(connA(), X);
  const xa2 = await author(connA2(), X);
  const yc = await comment(connA(), A.authorId);
  const c1 = await comment(connA(), xa1);
  const c2 = await comment(connA(), xa1, yc);
  const c3 = await comment(connA2(), xa2);
  const yr1 = await comment(connA(), A.authorId, c1);
  const yr2 = await comment(connA2(), null, { id: null, externalId: c3.externalId });
  const c1Children = await children(A, connA(), c1.id);
  const ycChildren = await children(A, connA(), yc.id);
  const xb = await author(connB(), X);
  const cb = await comment(connB(), xb);
  const cbChildren = await children(B, connB(), cb.id);
  return { xa1, xa2, yc, c1, c2, c3, yr1, yr2, c1Children, ycChildren, xb, cb, cbChildren };
}

async function authorRule(t: Tenant, entries: object[], list = 'block'): Promise<string> {
  const conditions = { type: 'author', list, platform: 'facebook', entries };
  return one(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions)
     VALUES ($1, $2, $3, $4::jsonb, 'hide', '[{"type":"hide"}]') RETURNING id`,
    [t.organizationId, t.brandId, `Authors ${randomUUID()}`, JSON.stringify(conditions)],
  );
}
const ruleRow = async (id: string) =>
  (
    await ctx.c.query<{ conditions: { entries: object[] }; enabled: boolean }>(
      'SELECT conditions, enabled FROM rule WHERE id = $1',
      [id],
    )
  ).rows[0]!;
const revision = async (t: Tenant) =>
  count('SELECT rule_revision AS n FROM brand WHERE id = $1', [t.brandId]);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const publicId = () =>
  Array.from({ length: 16 }, () => BASE32[Math.floor(Math.random() * 32)]).join('');
const apiKey = (t: Tenant) =>
  one(
    `INSERT INTO api_key (organization_id, name, public_id, secret_sha256, scope)
     VALUES ($1, $2, $3, decode(repeat('ef', 32), 'hex'), 'write') RETURNING id`,
    [t.organizationId, `k-${randomUUID()}`, publicId()],
  );

async function proposal(t: Tenant, entries: object[]): Promise<string> {
  const after = {
    name: 'Block',
    conditions: { type: 'author', list: 'block', platform: 'facebook', entries },
    actions: [{ type: 'hide' }],
    mode: 'enforce',
    enabled: true,
  };
  const diff = [{ field: 'conditions', before: null, after: after.conditions }];
  return one(
    `INSERT INTO rule_change_proposal (organization_id, brand_id, operation, after, diff,
                                       base_rule_revision, proposed_by_api_key_id, request_key, expires_at)
     VALUES ($1, $2, 'create', $3::jsonb, $4::jsonb, 0, $5, $6, now() + interval '1 day') RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      JSON.stringify(after),
      JSON.stringify(diff),
      await apiKey(t),
      `rk-${randomUUID()}`,
    ],
  );
}

async function auditEvent(t: Tenant, details: object): Promise<string> {
  return one(
    `INSERT INTO audit_event (organization_id, actor_type, action, subject_type, subject_id, details)
     VALUES ($1, 'system', 'seeded.event', 'organization', $1, $2::jsonb) RETURNING id`,
    [t.organizationId, JSON.stringify(details)],
  );
}

async function idempotencyRecord(t: Tenant, body: object): Promise<string> {
  return one(
    `INSERT INTO api_idempotency_record (organization_id, api_key_id, idempotency_key, request_sha256,
                                         state, response_status, response_body, expires_at)
     VALUES ($1, $2, $3, decode(repeat('01', 32), 'hex'), 'completed', 200, $4::jsonb,
             now() + interval '1 day') RETURNING id`,
    [t.organizationId, await apiKey(t), `key-${randomUUID()}`, JSON.stringify(body)],
  );
}

async function ledger(c: Conn, state: 'completed' | 'queued', payload: object): Promise<string> {
  return one(
    `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
                             payload, state, completed_at, expires_at)
     VALUES ($1, $2, $3, 'facebook', 'ingest_comment', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
             $4::jsonb, $5::text, CASE WHEN $5::text = 'completed' THEN now() END, now() + interval '30 days')
     RETURNING id`,
    [c.organizationId, c.brandId, c.connectionId, JSON.stringify(payload), state],
  );
}

/** Row counts of every table in the schema. */
async function everyTableCount(): Promise<Record<string, number>> {
  const { rows } = await ctx.c.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const out: Record<string, number> = {};
  for (const { tablename } of rows)
    out[tablename] = await count(`SELECT count(*) AS n FROM "${tablename}"`);
  return out;
}

const subjectComments = (organizationId: string, externalId: string) =>
  count(
    `SELECT count(*) AS n FROM comment c JOIN author a ON a.id = c.author_id
      WHERE c.organization_id = $1 AND a.external_id = $2`,
    [organizationId, externalId],
  );

describe('locateAuthorIds', () => {
  it('finds the subject on every connection of the organization, and nowhere else', async () => {
    const s = await seedSubject();
    const ids = await locateAuthorIds(ctx.c, A.organizationId, [fb(X)]);
    expect(new Set(ids)).toEqual(new Set([s.xa1, s.xa2]));
  });

  it('narrows to one connection when one is given, and ignores other platforms', async () => {
    const s = await seedSubject();
    const narrowed = await locateAuthorIds(ctx.c, A.organizationId, [
      { ...fb(X), connectionId: A2.connectionId },
    ]);
    expect(narrowed).toEqual([s.xa2]);
    const instagram = await locateAuthorIds(ctx.c, A.organizationId, [
      { platform: 'instagram', externalId: X },
    ]);
    expect(instagram).toEqual([]);
  });

  it('never matches handles against authors', async () => {
    await author(connA(), HANDLE);
    const ids = await locateAuthorIds(ctx.c, A.organizationId, [
      { platform: 'facebook', handle: HANDLE },
    ]);
    expect(ids).toEqual([]);
  });
});

describe('eraseSubject', () => {
  it("deletes the subject's comments, authors and everything that hangs off them, in this organization only", async () => {
    const s = await seedSubject();

    const r = await erase(A.organizationId, [fb(X)]);

    expect(r.found).toBe(true);
    expect(r.coverage).toBe('all_ingested_before_completed_at');
    expect(r.completedAt).toBeInstanceOf(Date);
    expect(r.counts).toEqual({
      ...ZERO,
      comments: 3,
      authors: 2,
      repliesMarkedParentRemoved: 2,
      reviewItemsCancelled: 1,
      suggestionsCancelled: 1,
      decisions: 1,
      previewResults: 1,
      moderationActions: 1,
    });
    for (const c of [s.c1, s.c2, s.c3]) expect(await exists('comment', c.id)).toBe(false);
    for (const a of [s.xa1, s.xa2]) expect(await exists('author', a)).toBe(false);
    for (const table of [
      'decision',
      'rule_evaluation',
      'review_item',
      'action_suggestion',
      'policy_preview_result',
      'comment_tag',
      'moderation_action',
      'webhook_event',
    ]) {
      expect(
        await count(`SELECT count(*) AS n FROM ${table} WHERE comment_id = $1`, [s.c1.id]),
        table,
      ).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM ${table} WHERE comment_id = $1`, [s.yc.id]),
        table,
      ).toBe(1);
    }
    // The pending outgoing delivery of the erased comment is never sent; others are untouched.
    expect(await exists('webhook_delivery', s.c1Children.delivery)).toBe(false);
    expect(await exists('webhook_delivery', s.ycChildren.delivery)).toBe(true);

    const fingerprints = await ctx.c.query<{ connection_id: string; fingerprint: Buffer }>(
      'SELECT connection_id, fingerprint FROM erased_comment',
    );
    expect(
      new Set(fingerprints.rows.map((f) => `${f.connection_id}:${f.fingerprint.toString('hex')}`)),
    ).toEqual(
      new Set(
        [
          [A.connectionId, s.c1.externalId],
          [A.connectionId, s.c2.externalId],
          [A2.connectionId, s.c3.externalId],
        ].map(([c, e]) => `${c}:${commentFingerprint(c!, e!).toString('hex')}`),
      ),
    );

    // Org B: same platform id, untouched.
    expect(await exists('author', s.xb)).toBe(true);
    expect(await exists('comment', s.cb.id)).toBe(true);
    expect(await exists('review_item', s.cbChildren.review)).toBe(true);
    expect(await exists('decision', s.cbChildren.decision)).toBe(true);
  });

  it("keeps other people's replies to the subject, marked as replying to a removed comment", async () => {
    const s = await seedSubject();

    await erase(A.organizationId, [fb(X)]);

    const replies = await ctx.c.query<{
      id: string;
      parent_removed_at: Date | null;
      parent_comment_id: string | null;
      parent_external_id: string | null;
    }>(
      `SELECT id, parent_removed_at, parent_comment_id, parent_external_id FROM comment
        WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[s.yr1.id, s.yr2.id]],
    );
    expect(replies.rows).toHaveLength(2);
    for (const r of replies.rows) {
      expect(r.parent_removed_at).toBeInstanceOf(Date);
      expect(r.parent_comment_id).toBeNull();
      expect(r.parent_external_id).toBeNull();
    }
    // X's reply to Y is gone; Y's comment is untouched.
    expect(await exists('comment', s.c2.id)).toBe(false);
    const yc = await ctx.c.query<{ parent_removed_at: Date | null; body: string }>(
      'SELECT parent_removed_at, body FROM comment WHERE id = $1',
      [s.yc.id],
    );
    expect(yc.rows[0]).toEqual({ parent_removed_at: null, body: `${MARKER} body` });
  });

  it('takes the subject out of the review queue and leaves every other item', async () => {
    const s = await seedSubject();
    const queue = new PgReviewQueue(pool);
    const scope = { organizationId: A.organizationId, brandId: A.brandId };
    const before = await queue.list(scope, { status: 'open', limit: 50 });
    expect(new Set(before.map((i) => i.id))).toEqual(
      new Set([s.c1Children.review, s.ycChildren.review]),
    );

    const r = await erase(A.organizationId, [fb(X)]);

    expect(r.counts.reviewItemsCancelled).toBe(1);
    expect(r.counts.suggestionsCancelled).toBe(1);
    const after = await queue.list(scope, { status: 'open', limit: 50 });
    expect(after.map((i) => i.id)).toEqual([s.ycChildren.review]);
    expect(await exists('action_suggestion', s.ycChildren.suggestion)).toBe(true);
  });

  it('removes matching rule entries, disables a rule left empty and bumps the revision', async () => {
    await seedSubject();
    const shared = await authorRule(A, [{ externalId: X }, { externalId: 'someone-else' }]);
    const only = await authorRule(A, [{ externalId: X }]);
    const archived = await authorRule(A, [{ externalId: X }, { externalId: 'someone-else' }]);
    await ctx.c.query('UPDATE rule SET archived_at = now(), enabled = false WHERE id = $1', [
      archived,
    ]);
    const otherOrg = await authorRule(B, [{ externalId: X }]);
    const rev = await revision(A);

    const r = await erase(A.organizationId, [fb(X)]);

    expect(r.counts.ruleEntriesRemoved).toBe(3);
    expect(r.counts.rulesDisabled).toBe(1);
    expect(r.counts.ruleEntriesKept).toBe(0);
    expect(await ruleRow(shared)).toMatchObject({
      enabled: true,
      conditions: { entries: [{ externalId: 'someone-else' }] },
    });
    const emptied = await ruleRow(only);
    expect(emptied.enabled).toBe(false);
    expect(JSON.stringify(emptied.conditions)).not.toContain(X);
    expect(await revision(A)).toBeGreaterThan(rev);
    expect(await ruleRow(archived)).toMatchObject({
      enabled: false,
      conditions: { entries: [{ externalId: 'someone-else' }] },
    });
    expect(await ruleRow(otherOrg)).toMatchObject({
      enabled: true,
      conditions: { entries: [{ externalId: X }] },
    });
    const audits = await ctx.c.query<{ details: object; actor_type: string }>(
      "SELECT details, actor_type FROM audit_event WHERE organization_id = $1 AND action = 'rule.updated'",
      [A.organizationId],
    );
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows.every((a) => a.actor_type === 'system')).toBe(true);
    expect(JSON.stringify(audits.rows)).not.toContain(X);
  });

  it('keeps rule entries when asked, and counts them', async () => {
    const shared = await authorRule(A, [{ externalId: X }, { externalId: 'someone-else' }]);
    const before = await ruleRow(shared);
    const rev = await revision(A);

    const r = await erase(A.organizationId, [fb(X)], {
      keepRuleEntries: { reason: 'Legal hold, ticket 42' },
    });

    expect(r.found).toBe(true);
    expect(r.counts).toEqual({ ...ZERO, ruleEntriesKept: 1 });
    expect(await ruleRow(shared)).toEqual(before);
    expect(await revision(A)).toBe(rev);
  });

  it('removes a handle-only entry for a handle-only identifier', async () => {
    const rule = await authorRule(A, [{ handle: HANDLE }, { handle: 'someone.else' }]);

    const r = await erase(A.organizationId, [{ platform: 'facebook', handle: '@Xavier.Handle' }]);

    expect(r.found).toBe(true);
    expect(r.counts).toEqual({ ...ZERO, ruleEntriesRemoved: 1 });
    expect((await ruleRow(rule)).conditions.entries).toEqual([{ handle: 'someone.else' }]);
  });

  it('redacts proposals and audit details, and makes a pending proposal stale', async () => {
    await authorRule(A, [{ externalId: X }]);
    const pending = await proposal(A, [{ externalId: X }, { externalId: 'someone-else' }]);
    const unrelated = await proposal(A, [{ externalId: 'someone-else' }]);
    const event = await auditEvent(A, {
      note: X,
      nested: { list: [{ externalId: X, handle: HANDLE }, { externalId: 'keep' }], n: 1 },
    });
    const other = await auditEvent(A, { note: 'keep' });
    const otherOrg = await auditEvent(B, { author: { externalId: X } });
    const before = (
      await ctx.c.query<{ action: string; created_at: Date; sequence: string }>(
        'SELECT action, created_at, sequence FROM audit_event WHERE id = $1',
        [event],
      )
    ).rows[0];

    const r = await erase(A.organizationId, [fb(X)]);

    expect(r.counts.proposalsRedacted).toBe(1);
    expect(r.counts.auditEventsRedacted).toBe(1);
    const p = (
      await ctx.c.query<{ status: string; doc: string }>(
        `SELECT status, json_build_array(before, after, diff)::text AS doc
           FROM rule_change_proposal WHERE id = $1`,
        [pending],
      )
    ).rows[0]!;
    expect(p.status).toBe('stale');
    expect(p.doc).not.toContain(X);
    expect(p.doc).toContain('[erased]');
    expect(p.doc).toContain('someone-else');
    expect(
      (await ctx.c.query('SELECT status FROM rule_change_proposal WHERE id = $1', [unrelated]))
        .rows[0],
    ).toEqual({ status: 'pending' });

    const a = (
      await ctx.c.query<{ action: string; created_at: Date; sequence: string; details: object }>(
        'SELECT action, created_at, sequence, details FROM audit_event WHERE id = $1',
        [event],
      )
    ).rows[0]!;
    expect({ action: a.action, created_at: a.created_at, sequence: a.sequence }).toEqual(before);
    expect(a.details).toEqual({
      note: X,
      nested: {
        list: [{ externalId: '[erased]', handle: '[erased]' }, { externalId: 'keep' }],
        n: 1,
      },
    });
    expect(
      (await ctx.c.query('SELECT details FROM audit_event WHERE id = $1', [other])).rows[0],
    ).toEqual({ details: { note: 'keep' } });
    expect(
      (await ctx.c.query('SELECT details FROM audit_event WHERE id = $1', [otherOrg])).rows[0],
    ).toEqual({ details: { author: { externalId: X } } });
  });

  it('leaves audit values that only equal an identifier, and redacts nothing for an unknown subject', async () => {
    const role = await auditEvent(A, { role: 'admin', capability: X, ruleId: X });
    const named = await auditEvent(A, { author: { externalId: 'ghost-id', handle: 'ghost' } });
    await erase(A.organizationId, [{ platform: 'facebook', handle: 'admin' }]);
    const r = await erase(A.organizationId, [fb(X), fb('ghost-id')]);

    expect(r.found).toBe(false);
    expect(r.counts.auditEventsRedacted).toBe(0);
    const details = async (id: string) =>
      (await ctx.c.query('SELECT details FROM audit_event WHERE id = $1', [id])).rows[0]!.details;
    expect(await details(role)).toEqual({ role: 'admin', capability: X, ruleId: X });
    expect(await details(named)).toEqual({ author: { externalId: 'ghost-id', handle: 'ghost' } });
  });

  it('matches audit handles after normalization', async () => {
    await authorRule(A, [{ handle: HANDLE }]);
    const event = await auditEvent(A, { author: { handle: HANDLE.toUpperCase() } });

    const r = await erase(A.organizationId, [{ platform: 'facebook', handle: `@${HANDLE}` }]);

    expect(r.counts.auditEventsRedacted).toBe(1);
    expect(
      (await ctx.c.query('SELECT details FROM audit_event WHERE id = $1', [event])).rows[0]!
        .details,
    ).toEqual({ author: { handle: '[erased]' } });
  });

  it('deletes idempotency records and finished ledger rows that refer to erased comments', async () => {
    const s = await seedSubject();
    const record = await idempotencyRecord(A, { data: { id: s.c1.id, body: `${MARKER}` } });
    const keptRecord = await idempotencyRecord(A, { data: { id: s.yc.id } });
    const done = await ledger(connA(), 'completed', { commentExternalId: s.c1.externalId });
    const queued = await ledger(connA(), 'queued', { commentExternalId: s.c2.externalId });
    const unrelated = await ledger(connA(), 'completed', { commentExternalId: s.yc.externalId });

    const r = await erase(A.organizationId, [fb(X)]);

    expect(r.counts.idempotencyRecords).toBe(1);
    expect(r.counts.jobLedgerRows).toBe(1);
    expect(await exists('api_idempotency_record', record)).toBe(false);
    expect(await exists('api_idempotency_record', keptRecord)).toBe(true);
    expect(await exists('job_ledger', done)).toBe(false);
    expect(await exists('job_ledger', queued)).toBe(true);
    expect(await exists('job_ledger', unrelated)).toBe(true);
  });

  it('removes cached responses and job records even when the first attempt fails after its batches', async () => {
    const s = await seedSubject();
    const record = await idempotencyRecord(A, { data: { id: s.c1.id, body: `${MARKER}` } });
    const done = await ledger(connA(), 'completed', { commentExternalId: s.c1.externalId });

    await expect(
      erase(A.organizationId, [fb(X)], {
        onStep: async (step) => {
          if (step === 'authors_deleted') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const retry = await erase(A.organizationId, [fb(X)]);

    expect(await exists('api_idempotency_record', record)).toBe(false);
    expect(await exists('job_ledger', done)).toBe(false);
    expect(retry.counts.comments).toBe(0);
  });

  it('dry run writes nothing and counts exactly what the erasure then does', async () => {
    const s = await seedSubject();
    await authorRule(A, [{ externalId: X }, { externalId: 'someone-else' }]);
    await authorRule(A, [{ externalId: X }]);
    await proposal(A, [{ externalId: X }]);
    await auditEvent(A, { author: { externalId: X } });
    await idempotencyRecord(A, { id: s.c3.id });
    await ledger(connA(), 'completed', { commentExternalId: s.c1.externalId });
    const before = await everyTableCount();
    const subjects = [fb(X), { platform: 'facebook' as const, handle: HANDLE }];

    const dry = await erase(A.organizationId, subjects, { dryRun: true });

    expect(await everyTableCount()).toEqual(before);
    expect(await count('SELECT count(*) AS n FROM erased_comment')).toBe(0);
    expect(dry.found).toBe(true);
    const done = await erase(A.organizationId, subjects);
    expect(dry.counts).toEqual(done.counts);
    expect(done.counts).toMatchObject({
      comments: 3,
      authors: 2,
      ruleEntriesRemoved: 2,
      rulesDisabled: 1,
      proposalsRedacted: 1,
      auditEventsRedacted: 1,
      idempotencyRecords: 1,
      jobLedgerRows: 1,
    });
  });

  it('dry run counts kept rule entries when entries are to be kept', async () => {
    await authorRule(A, [{ externalId: X }]);
    const dry = await erase(A.organizationId, [fb(X)], {
      dryRun: true,
      keepRuleEntries: { reason: 'hold' },
    });
    expect(dry.counts).toEqual({ ...ZERO, ruleEntriesKept: 1 });
  });

  it('finds nothing the second time', async () => {
    await seedSubject();
    await authorRule(A, [{ externalId: X }]);
    await erase(A.organizationId, [fb(X)]);

    const again = await erase(A.organizationId, [fb(X)]);

    expect(again.found).toBe(false);
    expect(again.counts).toEqual(ZERO);
  });

  it('finds nothing for an unknown identifier, without throwing', async () => {
    await seedSubject();
    const before = await everyTableCount();
    const r = await erase(A.organizationId, [fb('nobody-here')]);
    expect(r.found).toBe(false);
    expect(r.counts).toEqual(ZERO);
    expect(await everyTableCount()).toEqual(before);
  });

  it('matches identifiers exactly: wildcards, quotes, backslashes, long and non-Latin ids', async () => {
    const abc = await author(connA(), 'abc');
    await comment(connA(), abc);

    for (const pattern of ['a%', 'a_c', '%', '_bc', 'ABC']) {
      const r = await erase(A.organizationId, [fb(pattern)]);
      expect(r.found, pattern).toBe(false);
    }
    expect(await exists('author', abc)).toBe(true);

    for (const id of ["O'Brien\\", 'x'.repeat(255), 'שלום-עולם']) {
      const a = await author(connA(), id);
      await comment(connA(), a);
      const r = await erase(A.organizationId, [fb(id)]);
      expect(r.found, id.slice(0, 10)).toBe(true);
      expect(r.counts.authors).toBe(1);
      expect(r.counts.comments).toBe(1);
      expect(await exists('author', a)).toBe(false);
    }
    expect(await exists('author', abc)).toBe(true);
  });

  it('also erases a comment ingested for the subject while the erasure runs', async () => {
    await seedSubject();
    const store = new PgCommentStore(pool);
    let ingested = false;

    const r = await erase(A.organizationId, [fb(X)], {
      batchSize: 1,
      onStep: async (step) => {
        if (step !== 'comment_batch' || ingested) return;
        ingested = true;
        await store.upsertFromPlatform(
          { organizationId: A.organizationId, brandId: A.brandId, connectionId: A.connectionId },
          {
            externalId: `late-${randomUUID()}`,
            sourceExternalId: 'post-a-1',
            parentExternalId: null,
            author: { externalId: X, displayName: NAME, profileUrl: null },
            body: `${MARKER} late`,
            postedAt: new Date(),
            platformState: 'visible',
            permalink: null,
          },
          { ownAccountExternalId: 'page-a', syncedAt: new Date() },
        );
      },
    });

    expect(ingested).toBe(true);
    expect(r.counts.comments).toBe(4);
    expect(await subjectComments(A.organizationId, X)).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM author WHERE organization_id = $1 AND external_id = $2`,
        [A.organizationId, X],
      ),
    ).toBe(0);
  });

  it('goes back to the comments when one arrives just before the author rows are deleted', async () => {
    const s = await seedSubject();
    let late: { id: string } | null = null;

    const r = await erase(A.organizationId, [fb(X)], {
      onStep: async (step) => {
        if (step === 'before_authors' && !late) late = await comment(connA(), s.xa1);
      },
    });

    expect(late).not.toBeNull();
    expect(r.counts.comments).toBe(4);
    expect(r.counts.authors).toBe(2);
    expect(await subjectComments(A.organizationId, X)).toBe(0);
  });

  it('also erases an author row the subject gets on another connection meanwhile', async () => {
    await seedSubject();
    const connectionId = await one(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'facebook', 'page-a3') RETURNING id`,
      [A.organizationId, A.brandId],
    );
    const sourceId = await one(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
       VALUES ($1, $2, $3, 'ad_post', 'post-a3-1') RETURNING id`,
      [A.organizationId, A.brandId, connectionId],
    );
    const a3: Conn = { ...A, connectionId, sourceId };
    let lateAuthor: string | null = null;

    const r = await erase(A.organizationId, [fb(X)], {
      onStep: async (step) => {
        if (step !== 'before_authors' || lateAuthor) return;
        lateAuthor = await author(a3, X);
        await comment(a3, lateAuthor);
      },
    });

    expect(lateAuthor).not.toBeNull();
    expect(await exists('author', lateAuthor!)).toBe(false);
    expect(r.counts).toMatchObject({ comments: 4, authors: 3 });
    expect(await subjectComments(A.organizationId, X)).toBe(0);
  });

  it('completes when the author rows are deleted, not after the later steps', async () => {
    await seedSubject();
    await authorRule(A, [{ externalId: X }]);
    let authorsDeletedBy = new Date(0);

    const r = await erase(A.organizationId, [fb(X)], {
      onStep: async (step) => {
        if (step !== 'authors_deleted') return;
        authorsDeletedBy = new Date();
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    expect(authorsDeletedBy.getTime()).toBeGreaterThan(0);
    expect(r.completedAt.getTime()).toBeLessThanOrEqual(authorsDeletedBy.getTime());
  });

  it('leaves the count-only aggregates alone', async () => {
    const columns = await count(
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('alert_negative_hourly', 'policy_usage')
          AND (column_name LIKE '%author%' OR column_name LIKE '%comment%')`,
    );
    expect(columns).toBe(0);
    await seedSubject();
    await ctx.c.query(
      `INSERT INTO alert_negative_hourly (organization_id, brand_id, hour, negatives, total)
       VALUES ($1, $2, date_trunc('hour', now()), 2, 5)`,
      [A.organizationId, A.brandId],
    );
    await ctx.c.query(
      `INSERT INTO policy_usage (organization_id, brand_id, period_start, model_calls)
       VALUES ($1, $2, date_trunc('month', now())::date, 7)`,
      [A.organizationId, A.brandId],
    );
    const read = async () =>
      (
        await ctx.c.query(
          `SELECT (SELECT json_agg(h ORDER BY hour) FROM alert_negative_hourly h) AS hourly,
                  (SELECT json_agg(u ORDER BY id) FROM policy_usage u) AS usage`,
        )
      ).rows[0];
    const before = await read();

    await erase(A.organizationId, [fb(X)]);

    expect(await read()).toEqual(before);
  });

  it('never logs an identifier, handle, display name or comment text', async () => {
    const s = await seedSubject();
    await authorRule(A, [{ externalId: X }, { handle: HANDLE }]);
    await proposal(A, [{ externalId: X }]);
    await auditEvent(A, { note: X });
    await idempotencyRecord(A, { id: s.c1.id });
    const log = recorder();
    const subjects = [fb(X), { platform: 'facebook' as const, handle: HANDLE }];

    await erase(A.organizationId, subjects, { dryRun: true, log });
    await erase(A.organizationId, subjects, { batchSize: 1, log });

    expect(log.lines.length).toBeGreaterThan(0);
    const text = JSON.stringify(log.lines);
    for (const secret of [X, HANDLE, NAME, MARKER, s.c1.externalId])
      expect(text).not.toContain(secret);
  });
});
