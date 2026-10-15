import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '../testing/fixtures.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let A: Tenant;
let B: Tenant;
let commentA: string;
const SCORES = JSON.stringify({ spam: 0.9, scam_phishing: 0, harassment_abuse: 0, hate_speech: 0, sexual_content: 0, profanity: 0, self_promotion: 0 });
const POLICY = JSON.stringify([{ category: 'spam', threshold: 0.8, action: 'flag', source: 'default' }]);
const sha = (n: number) => Buffer.alloc(32, n);

beforeAll(async () => {
  ctx = await migratedDb();
  A = await seedTenant(ctx.c, 'a');
  B = await seedTenant(ctx.c, 'b');
  commentA = (await ctx.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id, body, platform_state, posted_at)
     VALUES ($1,$2,$3,$4,'ext-1',$5,'hello','visible',now()) RETURNING id`,
    [A.organizationId, A.brandId, A.connectionId, A.sourceId, A.authorId],
  )).rows[0]!.id;
});
afterAll(async () => ctx?.close());

const insertClassified = (over: Record<string, unknown> = {}) => {
  const v = { org: A.organizationId, brand: A.brandId, conn: A.connectionId, comment: commentA, sha: sha(1), trigger: 'ingest', scores: SCORES, ...over };
  return ctx.c.query<{ id: string }>(
    `INSERT INTO comment_classification (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key, status,
       provider, model, prompt_version, scores, language, language_supported, input_chars, policy)
     VALUES ($1,$2,$3,$4,$5,$6,'classified','openai','m','clf-v1',$7::jsonb,'en',true,5,$8::jsonb) RETURNING id`,
    [v.org, v.brand, v.conn, v.comment, v.sha, v.trigger, v.scores, POLICY],
  );
};

describe('classifier schema', () => {
  it('classifier_threshold: range, action and category checks; one row per brand+category', async () => {
    const ins = (cat: string, t: number, a: string) =>
      ctx.c.query(`INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action) VALUES ($1,$2,$3,$4,$5)`,
        [A.organizationId, A.brandId, cat, t, a]);
    await ins('spam', 0.5, 'hide');
    await expect(ins('spam', 0.6, 'flag')).rejects.toThrow(/classifier_threshold_brand_id_category_key/);
    await expect(ins('profanity', 1.01, 'flag')).rejects.toThrow(/classifier_threshold_threshold_check/);
    await expect(ins('profanity', -0.01, 'flag')).rejects.toThrow(/classifier_threshold_threshold_check/);
    await expect(ins('sentiment', 0.5, 'flag')).rejects.toThrow(/classifier_threshold_category_check/);
    await expect(ins('profanity', 0.5, 'delete')).rejects.toThrow(/classifier_threshold_action_check/);
  });
  it('classifier_threshold: cannot point at a brand of another organization', async () => {
    await expect(ctx.c.query(`INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action) VALUES ($1,$2,'spam',0.5,'flag')`,
      [A.organizationId, B.brandId])).rejects.toThrow(/fkey/);
  });
  it('comment_classification: unique per comment+sha+trigger; status consistency; score validity', async () => {
    await insertClassified();
    await expect(insertClassified()).rejects.toThrow(/comment_classification_comment_id_body_sha256_trigger_key_key/);
    await expect(insertClassified({ sha: sha(2), scores: SCORES.replace('0.9', '1.5') })).rejects.toThrow(/comment_classification_scores_check/);
    await expect(insertClassified({ sha: sha(3), scores: '{"spam":0.1}' })).rejects.toThrow(/comment_classification_scores_check/);
    await expect(insertClassified({ sha: sha(4), trigger: 'rerun:not-a-uuid' })).rejects.toThrow(/comment_classification_trigger_key_check/);
    await expect(ctx.c.query(
      `INSERT INTO comment_classification (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key, status, input_chars)
       VALUES ($1,$2,$3,$4,$5,'ingest','unclassified',5)`, [A.organizationId, A.brandId, A.connectionId, commentA, sha(5)],
    )).rejects.toThrow(/comment_classification_status_check/);
  });
  it('comment_classification: cross-tenant insert is refused by composite FKs', async () => {
    await expect(insertClassified({ sha: sha(6), conn: B.connectionId })).rejects.toThrow(/fkey/);
  });
  it('comment_classification: immutable except write-once fallback/recovered/reversed columns; no delete', async () => {
    const id = (await insertClassified({ sha: sha(7) })).rows[0]!.id;
    await expect(ctx.c.query(`UPDATE comment_classification SET outcome = 'hide' WHERE id = $1`, [id])).rejects.toThrow();
    await ctx.c.query(`UPDATE comment_classification SET fallback_at = now(), fallback_code = 'unsupported' WHERE id = $1`, [id]);
    await expect(ctx.c.query(`UPDATE comment_classification SET fallback_code = 'other' WHERE id = $1`, [id])).rejects.toThrow();
    await ctx.c.query(`UPDATE comment_classification SET reversed_at = now() WHERE id = $1`, [id]);
    await expect(ctx.c.query(`DELETE FROM comment_classification WHERE id = $1`, [id])).rejects.toThrow();
  });
  it('decision: classifier evidence required with classification_id; threshold only for classifier', async () => {
    const id = (await insertClassified({ sha: sha(8) })).rows[0]!.id;
    const dec = (cat: string | null, conf: number | null, thr: number | null, actor = 'classifier') =>
      ctx.c.query(
        `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, classifier_provider, classifier_model,
           category, confidence, threshold, classification_id, reason)
         VALUES ($1,$2,$3,'flag','enforce',$4,'openai','m',$5,$6,$7,$8,'r')`,
        [A.organizationId, A.brandId, commentA, actor, cat, conf, thr, id]);
    await dec('spam', 0.9, 0.8);
    await expect(dec(null, 0.9, 0.8)).rejects.toThrow(/decision_classifier_evidence_check/);
    await expect(dec('spam', 0.9, null)).rejects.toThrow(/decision_classifier_evidence_check/);
  });
  it('classifier_run: days 1..30', async () => {
    const ins = (d: number) => ctx.c.query(
      `INSERT INTO classifier_run (organization_id, brand_id, requested_by_user_id, days, since) VALUES ($1,$2,$3,$4, now())`,
      [A.organizationId, A.brandId, A.userId, d]);
    await ins(7);
    await expect(ins(31)).rejects.toThrow(/classifier_run_days_check/);
  });
});
