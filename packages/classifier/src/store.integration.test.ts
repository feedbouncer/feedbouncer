import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { DEFAULT_THRESHOLDS, ZERO_SCORES } from './defaults.js';
import { decide } from './policy.js';
import { prepareInput } from './prepare.js';
import { PgClassificationStore, type ClassificationRecord } from './store.js';
import type { Category, CategoryScores } from './types.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgClassificationStore;
let A: Tenant;
let B: Tenant;
let n = 0;

const brandScope = (t: Tenant) => ({ organizationId: t.organizationId, brandId: t.brandId });
const connScope = (t: Tenant) => ({ ...brandScope(t), connectionId: t.connectionId });
const sha = (s: string) => createHash('sha256').update(s).digest();

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'classifier-store-test',
    onIdleError: () => {},
  });
  store = new PgClassificationStore(pool);
  A = await seedTenant(ctx.c, 'cla');
  B = await seedTenant(ctx.c, 'clb');
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

async function newComment(
  t: Tenant,
  o: { body?: string; state?: string; origin?: string } = {},
): Promise<{ id: string; body: string }> {
  const body = o.body ?? `body ${++n}`;
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, platform_state,
       ingest_origin, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      t.sourceId,
      `ext-${randomUUID()}`,
      body,
      o.state ?? 'visible',
      o.origin ?? 'live',
    ],
  );
  return { id: r.rows[0]!.id, body };
}

async function ruleEvaluation(
  t: Tenant,
  commentId: string,
  hash: Buffer,
  triggerKey = 'ingest',
): Promise<string> {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key,
       ruleset_version, status) VALUES ($1, $2, $3, $4, $5, $6, 'v1', 'no_match') RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, commentId, hash, triggerKey],
  );
  return r.rows[0]!.id;
}

interface Made {
  rec: Extract<ClassificationRecord, { status: 'classified' }>;
  commentId: string;
}
async function classified(
  t: Tenant,
  o: {
    commentId?: string;
    body?: string;
    scores?: Partial<Record<Category, number>>;
    ruleDecided?: boolean;
    triggerKey?: string;
    provider?: string;
    model?: string;
    promptVersion?: string;
    lowSignal?: boolean;
  } = {},
): Promise<Made> {
  const c = o.commentId
    ? { id: o.commentId, body: o.body ?? '' }
    : await newComment(t, o.body === undefined ? {} : { body: o.body });
  const hash = sha(c.body);
  const triggerKey = o.triggerKey ?? 'ingest';
  const scores: CategoryScores = { ...ZERO_SCORES, ...o.scores };
  const input = prepareInput(o.lowSignal ? '!!' : c.body);
  const verdict = decide(scores, DEFAULT_THRESHOLDS, {
    lowSignal: input.lowSignal,
    languageSupported: true,
  });
  const rec = {
    commentId: c.id,
    sha: hash,
    triggerKey,
    status: 'classified' as const,
    provider: o.provider ?? 'openai',
    model: o.model ?? 'model-x',
    promptVersion: o.promptVersion ?? 'v1',
    scores,
    language: 'en',
    languageSupported: true,
    input,
    scoresReused: false,
    ruleEvaluationId: await ruleEvaluation(t, c.id, hash, triggerKey),
    ruleDecided: o.ruleDecided ?? false,
    policy: DEFAULT_THRESHOLDS,
    verdict,
    reason: 'Classifier: matched policy',
  };
  return { rec, commentId: c.id };
}

const decisions = (commentId: string) =>
  ctx.c.query(
    `SELECT outcome, actor_type, category, confidence::text, threshold::text, classifier_provider,
            classifier_model, classification_id, reason
     FROM decision WHERE comment_id = $1 ORDER BY sequence`,
    [commentId],
  );
const classRows = (commentId: string) =>
  ctx.c.query('SELECT * FROM comment_classification WHERE comment_id = $1', [commentId]);

describe('PgClassificationStore', () => {
  it('record(classified) inserts once and writes one classifier decision with evidence', async () => {
    const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
    const row = await store.record(connScope(A), rec);
    expect(row).toMatchObject({
      status: 'classified',
      outcome: 'hide',
      ruleDecided: false,
      provider: 'openai',
    });
    expect(row!.scores?.hate_speech).toBe(0.93);
    expect(row!.triggers).toHaveLength(1);
    expect(await store.record(connScope(A), rec)).toBeNull();
    const d = await decisions(commentId);
    expect(d.rows).toEqual([
      {
        outcome: 'hide',
        actor_type: 'classifier',
        category: 'hate_speech',
        confidence: '0.9300',
        threshold: '0.8000',
        classifier_provider: 'openai',
        classifier_model: 'model-x',
        classification_id: row!.id,
        reason: 'Classifier: matched policy',
      },
    ]);
    const cc = await classRows(commentId);
    expect(cc.rows).toHaveLength(1);
    expect(cc.rows[0]).toMatchObject({
      status: 'classified',
      outcome: 'hide',
      rule_decided: false,
      prompt_version: 'v1',
      language: 'en',
      language_supported: true,
      scores_reused: false,
      trigger_key: 'ingest',
    });
    expect(cc.rows[0].policy).toHaveLength(7);
  });

  it('record(classified) below every threshold stores the row with null outcome and no decision', async () => {
    const { rec, commentId } = await classified(A, { scores: { spam: 0.1 } });
    const row = await store.record(connScope(A), rec);
    expect(row).toMatchObject({
      status: 'classified',
      outcome: null,
      ruleDecided: false,
      triggers: [],
    });
    expect((await decisions(commentId)).rows).toHaveLength(0);
  });

  it('record(classified, ruleDecided) stores triggers but no outcome and no decision', async () => {
    const { rec, commentId } = await classified(A, {
      scores: { scam_phishing: 0.95 },
      ruleDecided: true,
    });
    const row = await store.record(connScope(A), rec);
    expect(row).toMatchObject({ status: 'classified', outcome: null, ruleDecided: true });
    expect(row!.triggers).toHaveLength(1);
    expect((await decisions(commentId)).rows).toHaveLength(0);
    const cc = await classRows(commentId);
    expect(cc.rows[0]).toMatchObject({ outcome: null, rule_decided: true });
    expect(cc.rows[0].triggers[0]).toMatchObject({ category: 'scam_phishing', score: 0.95 });
  });

  it('record(classified) with a low-signal downgrade stores the downgrade and a flag decision', async () => {
    const { rec, commentId } = await classified(A, {
      scores: { hate_speech: 0.9 },
      lowSignal: true,
    });
    const row = await store.record(connScope(A), rec);
    expect(row?.outcome).toBe('flag');
    const cc = await classRows(commentId);
    expect(cc.rows[0]).toMatchObject({ downgraded: 'low_signal', low_signal: true });
    expect((await decisions(commentId)).rows[0]).toMatchObject({
      outcome: 'flag',
      category: 'hate_speech',
    });
  });

  it('record() persists scores rounded to four decimals', async () => {
    const { rec, commentId } = await classified(A, { scores: { spam: 0.1 } });
    await store.record(connScope(A), { ...rec, scores: { ...rec.scores, spam: 0.80004 } });
    expect((await classRows(commentId)).rows[0].scores.spam).toBe(0.8);
  });

  it('record() throws when an outcome has no primary trigger and writes nothing', async () => {
    const { rec, commentId } = await classified(A, { scores: { spam: 0.1 } });
    const bad = {
      ...rec,
      verdict: { outcome: 'hide' as const, primary: null, triggers: [], downgraded: null },
    };
    await expect(store.record(connScope(A), bad)).rejects.toThrow();
    expect((await classRows(commentId)).rows).toHaveLength(0);
  });

  it('record(unclassified) writes no decision', async () => {
    const c = await newComment(A);
    const row = await store.record(connScope(A), {
      commentId: c.id,
      sha: sha(c.body),
      triggerKey: 'ingest',
      status: 'unclassified',
      unclassifiedReason: 'timeout',
      input: prepareInput(c.body),
    });
    expect(row).toMatchObject({
      status: 'unclassified',
      outcome: null,
      scores: null,
      provider: null,
      triggers: [],
    });
    expect((await decisions(c.id)).rows).toHaveLength(0);
    const cc = await classRows(c.id);
    expect(cc.rows[0]).toMatchObject({
      status: 'unclassified',
      unclassified_reason: 'timeout',
      input_chars: c.body.length,
      scores: null,
    });
  });

  it('record(skipped) stores the skip reason and input length, no decision', async () => {
    const c = await newComment(A);
    const row = await store.record(connScope(A), {
      commentId: c.id,
      sha: sha(c.body),
      triggerKey: 'ingest',
      status: 'skipped',
      skipReason: 'deleted',
      inputChars: 42,
    });
    expect(row).toMatchObject({ status: 'skipped', outcome: null });
    expect((await decisions(c.id)).rows).toHaveLength(0);
    expect((await classRows(c.id)).rows[0]).toMatchObject({
      skip_reason: 'deleted',
      input_chars: 42,
    });
  });

  it('record() into a foreign connection scope writes nothing', async () => {
    const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
    expect(await store.record(connScope(B), rec)).toBeNull();
    // right org/brand but a connection that is not the comment's own
    expect(await store.record({ ...connScope(A), connectionId: randomUUID() }, rec)).toBeNull();
    expect((await classRows(commentId)).rows).toHaveLength(0);
    expect((await decisions(commentId)).rows).toHaveLength(0);
  });

  it('find() returns the row for the same sha and trigger key, scoped to the brand', async () => {
    const { rec, commentId } = await classified(A, { scores: { spam: 0.9 } });
    const row = await store.record(connScope(A), rec);
    expect((await store.find(brandScope(A), commentId, rec.sha, 'ingest'))?.id).toBe(row!.id);
    expect(await store.find(brandScope(A), commentId, rec.sha, `rerun:${randomUUID()}`)).toBeNull();
    expect(await store.find(brandScope(A), commentId, sha('other'), 'ingest')).toBeNull();
    expect(await store.find(brandScope(B), commentId, rec.sha, 'ingest')).toBeNull();
  });

  it('findReusableScores matches only same sha + provider + model + prompt version, classified rows only', async () => {
    const first = await classified(A, { scores: { spam: 0.7, profanity: 0.2 } });
    await store.record(connScope(A), first.rec);
    const s = brandScope(A);
    const { commentId, rec } = first;
    const hit = await store.findReusableScores(s, commentId, rec.sha, 'openai', 'model-x', 'v1');
    expect(hit?.language).toBe('en');
    expect(hit?.scores.spam).toBe(0.7);
    expect(hit?.scores.profanity).toBe(0.2);
    expect(
      await store.findReusableScores(s, commentId, sha('x'), 'openai', 'model-x', 'v1'),
    ).toBeNull();
    expect(
      await store.findReusableScores(s, commentId, rec.sha, 'google', 'model-x', 'v1'),
    ).toBeNull();
    expect(
      await store.findReusableScores(s, commentId, rec.sha, 'openai', 'model-y', 'v1'),
    ).toBeNull();
    expect(
      await store.findReusableScores(s, commentId, rec.sha, 'openai', 'model-x', 'v2'),
    ).toBeNull();
    expect(
      await store.findReusableScores(brandScope(B), commentId, rec.sha, 'openai', 'model-x', 'v1'),
    ).toBeNull();

    const c = await newComment(A);
    await store.record(connScope(A), {
      commentId: c.id,
      sha: sha(c.body),
      triggerKey: 'ingest',
      status: 'unclassified',
      unclassifiedReason: 'unavailable',
      input: prepareInput(c.body),
    });
    expect(
      await store.findReusableScores(s, c.id, sha(c.body), 'openai', 'model-x', 'v1'),
    ).toBeNull();
  });

  it('recordFallback is write-once and appends one flag decision', async () => {
    const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
    const row = await store.record(connScope(A), rec);
    const id = row!.id;
    expect(await store.recordFallback(brandScope(B), id, 'unsupported', 'x')).toBe(false);
    expect(
      await store.recordFallback(
        brandScope(A),
        id,
        'unsupported',
        'Flagged for review: no connector',
      ),
    ).toBe(true);
    expect(await store.recordFallback(brandScope(A), id, 'unsupported', 'again')).toBe(false);
    const d = await decisions(commentId);
    expect(d.rows).toHaveLength(2);
    expect(d.rows[1]).toEqual({
      outcome: 'flag',
      actor_type: 'classifier',
      category: 'hate_speech',
      confidence: '0.9300',
      threshold: '0.8000',
      classifier_provider: 'openai',
      classifier_model: 'model-x',
      classification_id: id,
      reason: 'Flagged for review: no connector',
    });
    const cc = await classRows(commentId);
    expect(cc.rows[0].fallback_code).toBe('unsupported');
    expect(cc.rows[0].fallback_at).toBeInstanceOf(Date);
    const found = await store.find(brandScope(A), commentId, rec.sha, 'ingest');
    expect(found?.fallbackAt).toBeInstanceOf(Date);
  });

  it('recordFallback uses explicit evidence when given', async () => {
    const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
    const row = await store.record(connScope(A), rec);
    expect(
      await store.recordFallback(brandScope(A), row!.id, 'unsupported', 'r', {
        category: 'spam',
        score: 0.55,
        threshold: 0.5,
      }),
    ).toBe(true);
    const d = await decisions(commentId);
    expect(d.rows[1]).toMatchObject({
      outcome: 'flag',
      category: 'spam',
      confidence: '0.5500',
      threshold: '0.5000',
    });
  });

  it('recordRecovered requires a prior fallback and is write-once', async () => {
    const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
    const row = await store.record(connScope(A), rec);
    expect(await store.recordRecovered(brandScope(A), row!.id)).toBe(false);
    await store.recordFallback(brandScope(A), row!.id, 'failed', 'r');
    expect(await store.recordRecovered(brandScope(B), row!.id)).toBe(false);
    expect(await store.recordRecovered(brandScope(A), row!.id)).toBe(true);
    expect(await store.recordRecovered(brandScope(A), row!.id)).toBe(false);
    expect((await classRows(commentId)).rows[0].recovered_at).toBeInstanceOf(Date);
  });

  describe('reversibleClassifierHide', () => {
    const action = async (
      t: Tenant,
      commentId: string,
      o: { actor: string; kind: string; status?: string; key: string; at: string },
    ) =>
      ctx.c.query(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
           request_key, status, completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text,
           CASE WHEN $8::text = 'pending' THEN NULL ELSE now() END, $9::timestamptz)`,
        [
          t.organizationId,
          t.brandId,
          t.connectionId,
          commentId,
          o.kind,
          o.actor,
          o.key,
          o.status ?? 'applied',
          o.at,
        ],
      );

    it('returns the hide only when the latest pending/applied action is the classifier hide', async () => {
      const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
      const row = await store.record(connScope(A), rec);
      expect(await store.reversibleClassifierHide(brandScope(A), commentId)).toBeNull();
      await action(A, commentId, {
        actor: 'classifier',
        kind: 'hide',
        key: `clf:${row!.id}`,
        at: '2026-01-01T00:00:00Z',
      });
      expect(await store.reversibleClassifierHide(brandScope(A), commentId)).toEqual({
        classificationId: row!.id,
        category: 'hate_speech',
        threshold: 0.8,
      });
      expect(await store.reversibleClassifierHide(brandScope(B), commentId)).toBeNull();
      await action(A, commentId, {
        actor: 'user',
        kind: 'unhide',
        key: `u:${randomUUID()}`,
        at: '2026-01-02T00:00:00Z',
      });
      expect(await store.reversibleClassifierHide(brandScope(A), commentId)).toBeNull();
    });

    it('a later rule hide supersedes the classifier hide; failed actions are ignored', async () => {
      const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
      const row = await store.record(connScope(A), rec);
      await action(A, commentId, {
        actor: 'classifier',
        kind: 'hide',
        key: `clf:${row!.id}`,
        at: '2026-01-01T00:00:00Z',
      });
      await action(A, commentId, {
        actor: 'user',
        kind: 'unhide',
        status: 'failed',
        key: `u:${randomUUID()}`,
        at: '2026-01-02T00:00:00Z',
      });
      expect(await store.reversibleClassifierHide(brandScope(A), commentId)).toMatchObject({
        classificationId: row!.id,
      });
      await action(A, commentId, {
        actor: 'rule',
        kind: 'hide',
        key: `r:${randomUUID()}`,
        at: '2026-01-03T00:00:00Z',
      });
      expect(await store.reversibleClassifierHide(brandScope(A), commentId)).toBeNull();
    });

    it('a classifier hide that is not applied, or has a foreign request key, is not reversible', async () => {
      const a = await classified(A, { scores: { hate_speech: 0.93 } });
      const ra = await store.record(connScope(A), a.rec);
      await action(A, a.commentId, {
        actor: 'classifier',
        kind: 'hide',
        status: 'pending',
        key: `clf:${ra!.id}`,
        at: '2026-01-01T00:00:00Z',
      });
      expect(await store.reversibleClassifierHide(brandScope(A), a.commentId)).toBeNull();
      const b = await classified(A, { scores: { hate_speech: 0.93 } });
      await store.record(connScope(A), b.rec);
      await action(A, b.commentId, {
        actor: 'classifier',
        kind: 'hide',
        key: 'manual:1',
        at: '2026-01-01T00:00:00Z',
      });
      expect(await store.reversibleClassifierHide(brandScope(A), b.commentId)).toBeNull();
    });
  });

  it('recordReversal is write-once and appends an approve decision', async () => {
    const { rec, commentId } = await classified(A, { scores: { hate_speech: 0.93 } });
    const row = await store.record(connScope(A), rec);
    expect(await store.recordReversal(brandScope(B), row!.id, 'hate_speech', 0.2, 0.9, 'r')).toBe(
      false,
    );
    expect(
      await store.recordReversal(
        brandScope(A),
        row!.id,
        'hate_speech',
        0.2,
        0.9,
        'Approved: policy relaxed',
      ),
    ).toBe(true);
    expect(
      await store.recordReversal(brandScope(A), row!.id, 'hate_speech', 0.2, 0.9, 'again'),
    ).toBe(false);
    const d = await decisions(commentId);
    expect(d.rows).toHaveLength(2);
    expect(d.rows[1]).toEqual({
      outcome: 'approve',
      actor_type: 'classifier',
      category: 'hate_speech',
      confidence: '0.2000',
      threshold: '0.9000',
      classifier_provider: 'openai',
      classifier_model: 'model-x',
      classification_id: row!.id,
      reason: 'Approved: policy relaxed',
    });
    expect((await classRows(commentId)).rows[0].reversed_at).toBeInstanceOf(Date);
    expect(
      (await store.find(brandScope(A), commentId, rec.sha, 'ingest'))?.reversedAt,
    ).toBeInstanceOf(Date);
  });

  it('previewRows returns the latest classified, non-rule-decided row per live, non-deleted comment since a date, capped', async () => {
    const t = await seedTenant(ctx.c, `pv${++n}`);
    const s = brandScope(t);
    const cs = connScope(t);
    const old = await classified(t, { scores: { spam: 0.1 } });
    await store.record(cs, old.rec);
    const latest = await classified(t, { scores: { spam: 0.2 } });
    await store.record(cs, latest.rec);
    // a second, newer classification for the same comment (rerun)
    const rerun = await classified(t, {
      commentId: latest.commentId,
      body: (await ctx.c.query('SELECT body FROM comment WHERE id = $1', [latest.commentId]))
        .rows[0].body,
      scores: { spam: 0.9 },
      triggerKey: `rerun:${randomUUID()}`,
    });
    await new Promise((r) => setTimeout(r, 10));
    await store.record(cs, rerun.rec);
    const ruled = await classified(t, { scores: { spam: 0.3 }, ruleDecided: true });
    await store.record(cs, ruled.rec);
    const deleted = await classified(t, { scores: { spam: 0.4 } });
    await store.record(cs, deleted.rec);
    await ctx.c.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [
      deleted.commentId,
    ]);
    const backfilled = await newComment(t, { origin: 'backfill' });
    const bf = await classified(t, {
      commentId: backfilled.id,
      body: backfilled.body,
      scores: { spam: 0.5 },
    });
    await store.record(cs, bf.rec);
    const unc = await newComment(t);
    await store.record(cs, {
      commentId: unc.id,
      sha: sha(unc.body),
      triggerKey: 'ingest',
      status: 'unclassified',
      unclassifiedReason: 'timeout',
      input: prepareInput(unc.body),
    });

    const since = new Date(Date.now() - 3_600_000);
    const { rows, capped } = await store.previewRows(s, since, 100);
    expect(capped).toBe(false);
    const byId = new Map(rows.map((r) => [r.commentId, r]));
    expect([...byId.keys()].sort()).toEqual([old.commentId, latest.commentId].sort());
    expect(byId.get(latest.commentId)?.scores.spam).toBe(0.9);
    expect(byId.get(latest.commentId)).toMatchObject({ lowSignal: false, languageSupported: true });

    expect((await store.previewRows(s, new Date(Date.now() + 60_000), 100)).rows).toEqual([]);
    const capRes = await store.previewRows(s, since, 1);
    expect(capRes.capped).toBe(true);
    expect(capRes.rows.map((r) => r.commentId)).toEqual([latest.commentId]);
    expect(
      (await store.previewRows(brandScope(B), since, 100)).rows.map((r) => r.commentId),
    ).not.toContain(old.commentId);
  });

  it('latestForComment returns the newest classification mapped to the API shape, scoped to the brand', async () => {
    const { rec, commentId } = await classified(A, { scores: { spam: 0.85 }, lowSignal: true });
    expect(await store.latestForComment(brandScope(A), commentId)).toBeNull();
    const row = await store.record(connScope(A), rec);
    const v = await store.latestForComment(brandScope(A), commentId);
    expect(v).toMatchObject({
      id: row!.id,
      status: 'classified',
      skipReason: null,
      unclassifiedReason: null,
      provider: 'openai',
      model: 'model-x',
      language: 'en',
      languageSupported: true,
      lowSignal: true,
      truncated: false,
      inputChars: 2,
      ruleDecided: false,
      outcome: 'flag',
      downgraded: null,
    });
    expect(v?.scores?.spam).toBe(0.85);
    expect(typeof v?.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(v!.createdAt))).toBe(false);
    expect(await store.latestForComment(brandScope(B), commentId)).toBeNull();
  });
});
