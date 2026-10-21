import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import yauzl from 'yauzl';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { SubjectIdentifierT } from '../subject/identifier.js';
import { writeSubjectExport } from './export.js';

const X = 'X-psid-5521';
const X_NAME = 'Xenia Subject';
const Y = 'Y-psid-7781';
const Y_NAME = 'Yvonne Foreign';
const Z = 'Z-psid-9902';
const Z_NAME = 'Zed Foreign';
const Z_HANDLE = 'zed.foreign';
const MARKER_Y_REPLY = 'MARKER_Y_REPLY';
const MARKER_Y_PARENT = 'MARKER_Y_PARENT';
const MARKER_Z = 'MARKER_Z';
const MARKER_ORG_B = 'MARKER_ORG_B';

const MEMBERS = [
  'manifest.json',
  'authors.json',
  'comments.json',
  'decisions.json',
  'review_items.json',
  'moderation_actions.json',
  'policy_previews.json',
  'rule_entries.json',
  'operational.json',
];

const SCORES = {
  spam: 0.9,
  scam_phishing: 0,
  harassment_abuse: 0,
  hate_speech: 0,
  sexual_content: 0,
  profanity: 0,
  self_promotion: 0,
};
const POLICY = [{ category: 'spam', threshold: 0.8, action: 'flag', source: 'default' }];

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let A: Tenant;
let B: Tenant;
let dir: string;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'privacy-export-test', onIdleError: () => {} });
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

beforeEach(async () => {
  await ctx.c.query('DELETE FROM organization');
  A = await seedTenant(ctx.c, 'a');
  B = await seedTenant(ctx.c, 'b');
  dir = await mkdtemp(path.join(tmpdir(), 'fb-export-'));
  return () => rm(dir, { recursive: true, force: true });
});

const one = async (sql: string, v: unknown[] = []) =>
  (await ctx.c.query<{ id: string }>(sql, v)).rows[0]!.id;

const fb = (externalId: string): SubjectIdentifierT => ({ platform: 'facebook', externalId });

const author = (t: Tenant, externalId: string, name: string) =>
  one(
    `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, externalId, name],
  );

async function comment(
  t: Tenant,
  authorId: string,
  body: string,
  parent?: { id: string; externalId: string },
): Promise<{ id: string; externalId: string }> {
  const externalId = `c-${randomUUID()}`;
  const id = await one(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                          parent_comment_id, parent_external_id, body, permalink, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      t.sourceId,
      externalId,
      authorId,
      parent?.id ?? null,
      parent?.externalId ?? null,
      body,
      `https://facebook.example/${externalId}`,
    ],
  );
  return { id, externalId };
}

/** A decision, classifier scores, a policy evaluation, a review item, a reply and a preview verdict. */
async function children(t: Tenant, commentId: string, text: string) {
  const evaluation = await one(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                  trigger_key, ruleset_version, status)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'v1', 'no_match') RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, commentId],
  );
  await ctx.c.query(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
                           rule_evaluation_id, category, confidence, reason)
     VALUES ($1, $2, $3, 'hide', 'enforce', 'rule', $4, $5, 'spam', 0.91, $6)`,
    [t.organizationId, t.brandId, commentId, t.ruleId, evaluation, `${text} decision`],
  );
  await ctx.c.query(
    `INSERT INTO comment_classification (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, status, provider, model, prompt_version, scores, language, language_supported,
       input_chars, policy)
     VALUES ($1, $2, $3, $4, decode(repeat('cd', 32), 'hex'), 'ingest', 'classified', 'openai', 'm',
       'clf-v1', $5::jsonb, 'en', true, 5, $6::jsonb)`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      commentId,
      JSON.stringify(SCORES),
      JSON.stringify(POLICY),
    ],
  );
  await ctx.c.query(
    `INSERT INTO policy_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, status, skip_reason)
     VALUES ($1, $2, $3, $4, decode(repeat('ef', 32), 'hex'), 'ingest', 'skipped', 'rule_decided')`,
    [t.organizationId, t.brandId, t.connectionId, commentId],
  );
  await ctx.c.query(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, status)
     VALUES ($1, $2, $3, $4, 'user', 'open')`,
    [t.organizationId, t.brandId, t.connectionId, commentId],
  );
  await ctx.c.query(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                    actor_type, actor_user_id, request_key, reply_text, status, completed_at)
     VALUES ($1, $2, $3, $4, 'public_reply', 'user', $5, $6, $7, 'applied', now())`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      commentId,
      t.userId,
      `k-${randomUUID()}`,
      `${text} reply`,
    ],
  );
  const preview = await one(
    `INSERT INTO policy_preview (organization_id, brand_id, text, action, days, since, total, capped,
                                 status, completed_at)
     VALUES ($1, $2, 'No spam links please', 'hide', 7, now(), 1, false, 'done', now()) RETURNING id`,
    [t.organizationId, t.brandId],
  );
  await ctx.c.query(
    `INSERT INTO policy_preview_result (organization_id, brand_id, preview_id, connection_id, comment_id,
                                        position, verdict, proposed_action, reason)
     VALUES ($1, $2, $3, $4, $5, 0, 'clear_match', 'hide', $6)`,
    [t.organizationId, t.brandId, preview, t.connectionId, commentId, `${text} preview`],
  );
}

const ledger = (t: Tenant, state: 'completed' | 'queued', payload: object) =>
  one(
    `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
                             payload, state, completed_at, expires_at)
     VALUES ($1, $2, $3, 'facebook', 'ingest_comment', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
             $4::jsonb, $5::text, CASE WHEN $5::text = 'completed' THEN now() END, now() + interval '30 days')
     RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, JSON.stringify(payload), state],
  );

/**
 * Org A: X has three comments; c2 replies to Y's comment. Y and Z reply to X's c1. Every
 * comment carries the full set of child rows. A block list names X, Y and Z. Org B has an
 * author with X's platform id.
 */
async function seed() {
  const xa = await author(A, X, X_NAME);
  const ya = await author(A, Y, Y_NAME);
  const za = await author(A, Z, Z_NAME);
  const yParent = await comment(A, ya, `${MARKER_Y_PARENT} parent`);
  const c1 = await comment(A, xa, 'X body one');
  const c2 = await comment(A, xa, 'X body two', yParent);
  const c3 = await comment(A, xa, 'X body three');
  const yReply = await comment(A, ya, `${MARKER_Y_REPLY} reply`, c1);
  const zc = await comment(A, za, `${MARKER_Z} in thread`, c1);
  await children(A, c1.id, 'X own');
  await children(A, yParent.id, MARKER_Y_PARENT);
  await children(A, yReply.id, MARKER_Y_REPLY);
  await children(A, zc.id, MARKER_Z);
  const conditions = {
    type: 'author',
    list: 'block',
    platform: 'facebook',
    entries: [{ externalId: X }, { externalId: Y }, { handle: Z_HANDLE }],
  };
  const ruleId = await one(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions)
     VALUES ($1, $2, 'Blocked authors', $3::jsonb, 'hide', '[{"type":"hide"}]') RETURNING id`,
    [A.organizationId, A.brandId, JSON.stringify(conditions)],
  );
  await ledger(A, 'completed', { commentExternalId: c1.externalId });
  await ledger(A, 'queued', { commentExternalId: c1.externalId });
  await ledger(A, 'completed', { commentExternalId: yReply.externalId });
  await ledger(A, 'completed', { commentExternalId: zc.externalId });
  const xb = await author(B, X, 'Org B name');
  const cb = await comment(B, xb, `${MARKER_ORG_B} body`);
  await children(B, cb.id, MARKER_ORG_B);
  return { c1, c2, c3, yParent, yReply, zc, ruleId, cb };
}

function readZip(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, s) => {
          if (e) return reject(e);
          const chunks: Buffer[] = [];
          s.on('data', (c: Buffer) => chunks.push(c));
          s.on('error', reject);
          s.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

type Json = Record<string, unknown>;

async function exportFor(t: Tenant, subjects: SubjectIdentifierT[], requestId = randomUUID()) {
  const result = await writeSubjectExport(pool, t.organizationId, requestId, subjects, { dir });
  const file = path.join(dir, `${requestId}.zip`);
  const members = await readZip(file);
  const json = (name: string) => JSON.parse(members.get(name)!.toString('utf8')) as Json[];
  return { result, requestId, file, members, json };
}

describe('writeSubjectExport', () => {
  it('marks a reply whose parent was removed, but not one whose parent is not ingested yet', async () => {
    const s = await seed();
    await ctx.c.query(
      `UPDATE comment SET parent_comment_id = NULL, parent_external_id = NULL, parent_removed_at = now()
        WHERE id = $1`,
      [s.c2.id],
    );
    await ctx.c.query(`UPDATE comment SET parent_external_id = 'not-ingested-yet' WHERE id = $1`, [
      s.c3.id,
    ]);
    const { json } = await exportFor(A, [fb(X)]);
    const comments = json('comments.json');
    expect(comments.find((c) => c.id === s.c2.id)!.inReplyTo).toEqual({
      commentId: null,
      removed: true,
    });
    expect(comments.find((c) => c.id === s.c3.id)!.inReplyTo).toEqual({
      commentId: null,
      removed: false,
    });
  });

  it('writes every member as JSON, with the subject’s data and matching manifest counts', async () => {
    const s = await seed();
    const { result, requestId, members, json } = await exportFor(A, [fb(X)]);

    expect([...members.keys()].sort()).toEqual([...MEMBERS].sort());
    expect(result.found).toBe(true);
    const manifest = JSON.parse(members.get('manifest.json')!.toString('utf8')) as Json;
    expect(manifest).toMatchObject({
      format: 'feedbouncer.subject-export',
      version: 1,
      requestId,
      organizationId: A.organizationId,
      subjects: [fb(X)],
      notIncluded: [
        'Data held by the source platform or by third-party AI providers.',
        'Other identities of this person that were not supplied as identifiers.',
        'Copies in backups or replicas managed by the operator.',
      ],
    });
    const counts = manifest.counts as Record<string, number>;
    expect(Object.keys(counts).sort()).toEqual(
      MEMBERS.filter((m) => m !== 'manifest.json')
        .map((m) => m.replace('.json', ''))
        .sort(),
    );
    for (const [member, n] of Object.entries(counts))
      expect(json(`${member}.json`)).toHaveLength(n);
    expect(result.counts).toEqual(counts);

    const comments = json('comments.json');
    expect(comments.map((c) => c.body).sort()).toEqual([
      'X body one',
      'X body three',
      'X body two',
    ]);
    const reply = comments.find((c) => c.id === s.c2.id)!;
    expect(reply.inReplyTo).toEqual({ commentId: s.yParent.id, removed: false });
    expect(comments.find((c) => c.id === s.c1.id)!.inReplyTo).toBeNull();
    expect(Object.keys(reply).sort()).toEqual(
      [
        'id',
        'platform',
        'connectionId',
        'externalId',
        'permalink',
        'body',
        'postedAt',
        'ingestedAt',
        'platformState',
        'inReplyTo',
      ].sort(),
    );

    expect(json('authors.json')).toEqual([
      expect.objectContaining({
        platform: 'facebook',
        connectionId: A.connectionId,
        externalId: X,
        displayName: X_NAME,
      }),
    ]);
    const decisions = json('decisions.json');
    expect(decisions).toContainEqual(
      expect.objectContaining({
        kind: 'decision',
        commentId: s.c1.id,
        outcome: 'hide',
        mode: 'enforce',
        actorType: 'rule',
        category: 'spam',
        confidence: 0.91,
        reason: 'X own decision',
      }),
    );
    expect(decisions).toContainEqual(
      expect.objectContaining({ kind: 'classifier_scores', commentId: s.c1.id, scores: SCORES }),
    );
    expect(decisions).toContainEqual(
      expect.objectContaining({ kind: 'policy_evaluation', commentId: s.c1.id, outcome: null }),
    );
    expect(json('review_items.json')).toEqual([
      expect.objectContaining({ commentId: s.c1.id, status: 'open', source: 'user' }),
    ]);
    expect(json('moderation_actions.json')).toEqual([
      expect.objectContaining({
        kind: 'public_reply',
        replyText: 'X own reply',
        status: 'applied',
      }),
    ]);
    expect(json('policy_previews.json')).toEqual([
      expect.objectContaining({
        verdict: 'clear_match',
        proposedAction: 'hide',
        reason: 'X own preview',
      }),
    ]);
    expect(json('rule_entries.json')).toEqual([
      {
        ruleId: s.ruleId,
        ruleName: 'Blocked authors',
        list: 'block',
        platform: 'facebook',
        matchedBy: 'externalId',
      },
    ]);
    expect(json('operational.json')).toEqual([
      { jobType: 'ingest_comment', state: 'completed', createdAt: expect.any(String) },
    ]);
  });

  it('never exports another person’s text, ids or names, or another organization’s data', async () => {
    const s = await seed();
    const foreign = [
      MARKER_Y_REPLY,
      MARKER_Y_PARENT,
      MARKER_Z,
      MARKER_ORG_B,
      Y,
      Y_NAME,
      Z,
      Z_NAME,
      Z_HANDLE,
      s.yParent.externalId,
      s.yReply.externalId,
      s.zc.externalId,
      s.yReply.id,
      s.zc.id,
      s.cb.id,
      s.cb.externalId,
      B.organizationId,
      'Org B name',
    ];
    const { members } = await exportFor(A, [fb(X)]);
    expect(members.size).toBe(MEMBERS.length);
    for (const [name, bytes] of members) {
      for (const marker of foreign) {
        expect({ name, found: bytes.includes(Buffer.from(marker, 'utf8')) }).toEqual({
          name,
          found: false,
        });
      }
    }
  });

  it('exports only the requested organization’s rows for a platform id seen in two', async () => {
    await seed();
    const { json, members } = await exportFor(B, [fb(X)]);
    expect(json('comments.json').map((c) => c.body)).toEqual([`${MARKER_ORG_B} body`]);
    for (const bytes of members.values()) {
      for (const marker of ['X body', 'X own', X_NAME, A.organizationId, A.connectionId])
        expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
  });

  it('writes every member, empty, for an identifier that matches nothing', async () => {
    await seed();
    const { result, members, json } = await exportFor(A, [fb('nobody-here')]);
    expect(result.found).toBe(false);
    expect([...members.keys()].sort()).toEqual([...MEMBERS].sort());
    for (const name of MEMBERS.filter((m) => m !== 'manifest.json')) expect(json(name)).toEqual([]);
    const manifest = JSON.parse(members.get('manifest.json')!.toString('utf8')) as Json;
    expect(Object.values(manifest.counts as object).every((n) => n === 0)).toBe(true);
  });

  it('streams a 20,000-comment history without holding it in memory [slow]', async () => {
    const xa = await author(A, X, X_NAME);
    await ctx.c.query(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                            body, posted_at)
       SELECT $1, $2, $3, $4, 'bulk-' || g, $5, repeat('lorem ipsum ', 200) || g, now()
         FROM generate_series(1, 20000) g`,
      [A.organizationId, A.brandId, A.connectionId, A.sourceId, xa],
    );
    const requestId = randomUUID();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);
    let result;
    try {
      result = await writeSubjectExport(pool, A.organizationId, requestId, [fb(X)], { dir });
    } finally {
      clearInterval(sample);
    }
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    expect(peak - before).toBeLessThan(64 * 1024 * 1024);
    expect(result.counts.comments).toBe(20_000);
    const members = await readZip(path.join(dir, `${requestId}.zip`));
    expect(JSON.parse(members.get('comments.json')!.toString('utf8'))).toHaveLength(20_000);
  }, 300_000);

  it('writes a 0600 file atomically, reports its size and hash, and never overwrites', async () => {
    await seed();
    const { result, requestId, file } = await exportFor(A, [fb(X)]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([`${requestId}.zip`]);
    const bytes = await readFile(file);
    expect(result.bytes).toBe(bytes.length);
    const { createHash } = await import('node:crypto');
    expect(result.sha256.equals(createHash('sha256').update(bytes).digest())).toBe(true);

    await expect(
      writeSubjectExport(pool, A.organizationId, requestId, [fb(X)], { dir }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await readFile(file)).equals(bytes)).toBe(true);
    expect(await readdir(dir)).toEqual([`${requestId}.zip`]);
  });

  it('refuses a request id that is not a uuid before touching the filesystem', async () => {
    for (const id of ['../x', '..', `${randomUUID()}/../x`, `${randomUUID()}x`, ''])
      await expect(
        writeSubjectExport(pool, A.organizationId, id, [fb(X)], { dir }),
      ).rejects.toThrow(/request id/i);
    expect(await readdir(dir)).toEqual([]);
    for (const leaked of ['x.zip.part', 'x.zip'])
      await expect(stat(path.join(dir, '..', leaked))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the partial file when the export fails', async () => {
    const bad = { platform: 'facebook', externalId: X, connectionId: 'not-a-uuid' } as const;
    await expect(
      writeSubjectExport(pool, A.organizationId, randomUUID(), [bad], { dir }),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});
