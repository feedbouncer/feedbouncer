// comment_classify over real Postgres: real comment, evaluation, classification
// and threshold stores and BrandSlots; scripted provider and stubbed actions.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgCommentStore } from '@feedbouncer/comments';
import { JobDeferral, type JobContext } from '@feedbouncer/jobs';
import { PgEvaluationStore, bodySha256, type RuleAction } from '@feedbouncer/rules';
import { createLogger } from '@feedbouncer/service-runtime';
import {
  editCommentRow,
  evaluateRulesFor,
  fakeJobContext,
  seedCommentRow,
  type Seeded,
} from '../testing.js';
import { ZERO_SCORES } from '../defaults.js';
import {
  ClassifierProviderError,
  DisabledProvider,
  type ClassifierProvider,
  type RawClassification,
} from '../provider.js';
import { BrandSlots } from '../slots.js';
import { PgClassificationStore } from '../store.js';
import { PgThresholdStore } from '../thresholds-store.js';
import type { CategoryScores, PreparedInput, Trigger } from '../types.js';
import { classifyCommentJob, type ClassifyDeps } from './classify.js';
import { CLASSIFY_JOB, type ClassifyPayload } from './specs.js';

const quiet = createLogger('classify-test', 'error', () => {});
const LANGS = ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl'];

class FakeProvider implements ClassifierProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  calls = 0;
  inputs: PreparedInput[] = [];
  constructor(private readonly script: Array<RawClassification | ClassifierProviderError>) {}
  async classify(input: PreparedInput): Promise<RawClassification> {
    this.inputs.push(input);
    const next = this.script[Math.min(this.calls++, this.script.length - 1)]!;
    if (next instanceof ClassifierProviderError) throw next;
    return next;
  }
}
const S = (o: Partial<CategoryScores> = {}, language = 'en'): RawClassification => ({
  scores: { ...ZERO_SCORES, ...o },
  language,
});

let ctxDb: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let slotPool: pg.Pool;
let comments: PgCommentStore;
let evaluations: PgEvaluationStore;
let classifications: PgClassificationStore;
let thresholds: PgThresholdStore;
let slots: BrandSlots;
let actions: { request: ReturnType<typeof vi.fn> };
let n = 0;

beforeAll(async () => {
  ctxDb = await migratedDb();
  pool = createPool(ctxDb.db.url, { applicationName: 'classify-test', onIdleError: () => {} });
  slotPool = createPool(ctxDb.db.url, { applicationName: 'classify-slots', onIdleError: () => {} });
  comments = new PgCommentStore(pool);
  evaluations = new PgEvaluationStore(pool);
  classifications = new PgClassificationStore(pool);
  thresholds = new PgThresholdStore(pool);
  slots = new BrandSlots(slotPool, 2);
});
afterAll(async () => {
  await pool.end();
  await slotPool.end();
  await ctxDb.close();
});
beforeEach(() => {
  actions = {
    request: vi.fn().mockResolvedValue({ status: 'accepted', action: { status: 'pending' } }),
  };
});

const tenant = () => seedTenant(ctxDb.c, `clj${++n}`);
const seedComment = async (body: string, t?: Tenant, o: { state?: string; own?: boolean } = {}) =>
  seedCommentRow(ctxDb.c, t ?? (await tenant()), body, o);
const editComment = (c: Seeded, body: string) => editCommentRow(ctxDb.c, c, body);
const evaluateRules = (c: Seeded, status: 'no_match' | 'decided' | 'skipped') =>
  evaluateRulesFor(evaluations, c, status);

async function setThreshold(t: Tenant, category: string, threshold: number, action: RuleAction) {
  await ctxDb.c.query(
    `INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [t.organizationId, t.brandId, category, threshold, action, t.userId],
  );
}

function job(provider: ClassifierProvider, o: Partial<ClassifyDeps> = {}) {
  return classifyCommentJob({
    comments,
    ruleEvaluations: evaluations,
    classifications,
    thresholds,
    provider,
    slots,
    actions: actions as never,
    languages: LANGS,
    maxWaitMs: 1_800_000,
    log: quiet,
    clock: { now: () => Date.now() },
    ...o,
  });
}

const ctx = (c: Seeded, attempt: number, connectionId = c.t.connectionId): JobContext =>
  fakeJobContext(c.t, attempt, CLASSIFY_JOB.type, quiet, connectionId);
const payload = (c: { id: string; body: string }): ClassifyPayload => ({
  commentId: c.id,
  bodySha256: bodySha256(c.body),
  trigger: 'ingest',
  requestedAt: Date.now(),
});

const one = async (sql: string, v: unknown[]) => (await ctxDb.c.query(sql, v)).rows[0];
const count = async (sql: string, v: unknown[]) => (await ctxDb.c.query(sql, v)).rowCount ?? 0;

describe('comment_classify', () => {
  it('stores all seven scores for a no-match comment and applies default thresholds (hide on hate speech)', async () => {
    const c = await seedComment('you people are awful');
    await evaluateRules(c, 'no_match');
    const r = await job(new FakeProvider([S({ hate_speech: 0.93, spam: 0.85 })])).handle(
      ctx(c, 1),
      payload(c),
    );
    expect(r).toMatchObject({ result: 'classified', outcome: 'hide' });
    const row = await one(
      `SELECT scores, triggers, policy, outcome FROM comment_classification WHERE comment_id = $1`,
      [c.id],
    );
    expect(Object.keys(row.scores)).toHaveLength(7);
    expect(row.triggers.map((t: Trigger) => t.category).sort()).toEqual(['hate_speech', 'spam']);
    expect(actions.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'hide',
        actor: { type: 'classifier' },
        requestKey: `clf:${r.classificationId}`,
      }),
    );
    const dec = await one(
      `SELECT category, confidence::text, threshold::text, reason FROM decision WHERE classification_id = $1`,
      [r.classificationId],
    );
    expect(dec).toMatchObject({
      category: 'hate_speech',
      confidence: '0.9300',
      threshold: '0.8000',
    });
    expect(dec.reason).toContain('Also triggered: Spam 0.85');
  });

  it('per-brand override beats the default; another brand still uses defaults', async () => {
    const tenantA = await tenant();
    const tenantB = await tenant();
    await setThreshold(tenantA, 'spam', 0.5, 'remove');
    const a = await seedComment('offer', tenantA);
    await evaluateRules(a, 'no_match');
    const b = await seedComment('offer', tenantB);
    await evaluateRules(b, 'no_match');
    const ra = await job(new FakeProvider([S({ spam: 0.6 })])).handle(ctx(a, 1), payload(a));
    expect(ra.outcome).toBe('remove');
    expect(actions.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'delete' }));
    expect(
      (await job(new FakeProvider([S({ spam: 0.6 })])).handle(ctx(b, 1), payload(b))).outcome,
    ).toBeNull();
  });

  it('a rule decision wins: scores stored, no classifier decision, no classifier action', async () => {
    const c = await seedComment('bad words here');
    await evaluateRules(c, 'decided');
    const r = await job(new FakeProvider([S({ hate_speech: 0.99 })])).handle(ctx(c, 1), payload(c));
    expect(r).toMatchObject({ result: 'classified', outcome: null });
    expect(
      await count(`SELECT 1 FROM decision WHERE classification_id = $1`, [r.classificationId]),
    ).toBe(0);
    expect(actions.request).not.toHaveBeenCalled();
    expect(
      (
        await one(`SELECT rule_decided FROM comment_classification WHERE id = $1`, [
          r.classificationId,
        ])
      ).rule_decided,
    ).toBe(true);
  });

  it('boundary: 0.80004 is stored as 0.8 and triggers a 0.8 threshold; 0.7999 does not', async () => {
    const hi = await seedComment('boundary high');
    await evaluateRules(hi, 'no_match');
    const lo = await seedComment('boundary low');
    await evaluateRules(lo, 'no_match');
    const rh = await job(new FakeProvider([S({ hate_speech: 0.80004 })])).handle(
      ctx(hi, 1),
      payload(hi),
    );
    const rl = await job(new FakeProvider([S({ hate_speech: 0.7999 })])).handle(
      ctx(lo, 1),
      payload(lo),
    );
    expect(rh.outcome).toBe('hide');
    expect(rl.outcome).toBeNull();
    const row = await one(`SELECT scores FROM comment_classification WHERE comment_id = $1`, [
      hi.id,
    ]);
    expect(row.scores.hate_speech).toBe(0.8);
    const row2 = await one(`SELECT scores FROM comment_classification WHERE comment_id = $1`, [
      lo.id,
    ]);
    expect(row2.scores.hate_speech).toBe(0.7999);
  });

  it('provider failures retry with backoff, then mark unclassified with no action', async () => {
    const c = await seedComment('slow provider');
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([new ClassifierProviderError('timeout', true)]);
    await expect(job(p).handle(ctx(c, 1), payload(c))).rejects.toMatchObject({
      kind: 'retryable',
      code: 'classifier_timeout',
    });
    await expect(job(p).handle(ctx(c, 2), payload(c))).rejects.toMatchObject({ kind: 'retryable' });
    const r = await job(p).handle(ctx(c, 3), payload(c));
    expect(r).toMatchObject({ result: 'unclassified' });
    expect(
      (
        await one(`SELECT unclassified_reason FROM comment_classification WHERE comment_id = $1`, [
          c.id,
        ])
      ).unclassified_reason,
    ).toBe('timeout');
    expect(actions.request).not.toHaveBeenCalled();
    expect(
      await count(`SELECT 1 FROM decision WHERE comment_id = $1 AND actor_type = 'classifier'`, [
        c.id,
      ]),
    ).toBe(0);
  });

  it('a disabled provider records unclassified/disabled without taking a brand slot', async () => {
    const c = await seedComment('anything');
    await evaluateRules(c, 'no_match');
    const acquire = vi.fn();
    const r = await job(new DisabledProvider(), { slots: { acquire } as never }).handle(
      ctx(c, 1),
      payload(c),
    );
    expect(r).toMatchObject({ result: 'unclassified' });
    expect(acquire).not.toHaveBeenCalled();
    expect(
      (
        await one(`SELECT unclassified_reason FROM comment_classification WHERE comment_id = $1`, [
          c.id,
        ])
      ).unclassified_reason,
    ).toBe('disabled');
  });

  it('non-retryable failures (auth, disabled) mark unclassified on the first attempt', async () => {
    const c = await seedComment('no provider');
    await evaluateRules(c, 'no_match');
    expect(await job(new DisabledProvider()).handle(ctx(c, 1), payload(c))).toMatchObject({
      result: 'unclassified',
    });
    const d = await seedComment('bad key');
    await evaluateRules(d, 'no_match');
    const p = new FakeProvider([new ClassifierProviderError('auth', false)]);
    expect(await job(p).handle(ctx(d, 1), payload(d))).toMatchObject({ result: 'unclassified' });
    expect(p.calls).toBe(1);
    expect(
      (
        await one(`SELECT unclassified_reason FROM comment_classification WHERE comment_id = $1`, [
          d.id,
        ])
      ).unclassified_reason,
    ).toBe('auth');
  });

  it('invalid model output after retries is unclassified invalid_output and never clamped', async () => {
    const c = await seedComment('weird output');
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([new ClassifierProviderError('invalid_output', true)]);
    await expect(job(p).handle(ctx(c, 1), payload(c))).rejects.toMatchObject({ kind: 'retryable' });
    await expect(job(p).handle(ctx(c, 2), payload(c))).rejects.toMatchObject({ kind: 'retryable' });
    expect(await job(p).handle(ctx(c, 3), payload(c))).toMatchObject({ result: 'unclassified' });
    const row = await one(
      `SELECT status, unclassified_reason, scores FROM comment_classification WHERE comment_id = $1`,
      [c.id],
    );
    expect(row).toEqual({
      status: 'unclassified',
      unclassified_reason: 'invalid_output',
      scores: null,
    });
    expect(actions.request).not.toHaveBeenCalled();
  });

  it('duplicate deliveries classify once and request the action once', async () => {
    const c = await seedComment('click this link');
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([S({ scam_phishing: 0.9 })]);
    const r1 = await job(p).handle(ctx(c, 1), payload(c));
    const r2 = await job(p).handle(ctx(c, 1), payload(c));
    expect(r2.classificationId).toBe(r1.classificationId);
    expect(p.calls).toBe(1);
    expect(new Set(actions.request.mock.calls.map((x) => x[0].requestKey))).toEqual(
      new Set([`clf:${r1.classificationId}`]),
    );
    expect(await count(`SELECT 1 FROM decision WHERE comment_id = $1`, [c.id])).toBe(1);
  });

  it('an edit (new body) is classified again; the stale job is superseded', async () => {
    const c = await seedComment('first');
    await evaluateRules(c, 'no_match');
    const oldPayload = payload(c);
    const edited = await editComment(c, 'second');
    await evaluateRules(edited, 'no_match');
    expect(await job(new FakeProvider([S()])).handle(ctx(c, 1), oldPayload)).toEqual({
      result: 'superseded',
    });
    expect(
      (await job(new FakeProvider([S()])).handle(ctx(edited, 1), payload(edited))).result,
    ).toBe('classified');
  });

  it('deleted and own-account comments are skipped without a provider call', async () => {
    const p = new FakeProvider([S({ spam: 0.99 })]);
    const del = await seedComment('gone', undefined, { state: 'deleted' });
    const own = await seedComment('mine', undefined, { own: true });
    expect(await job(p).handle(ctx(del, 1), payload(del))).toMatchObject({ result: 'skipped' });
    expect(await job(p).handle(ctx(own, 1), payload(own))).toMatchObject({ result: 'skipped' });
    expect(p.calls).toBe(0);
    expect(
      (await one(`SELECT skip_reason FROM comment_classification WHERE comment_id = $1`, [del.id]))
        .skip_reason,
    ).toBe('deleted');
    expect(
      (await one(`SELECT skip_reason FROM comment_classification WHERE comment_id = $1`, [own.id]))
        .skip_reason,
    ).toBe('own_account');
    expect(actions.request).not.toHaveBeenCalled();
  });

  it('empty text is classified without a provider call (zero scores, builtin/empty-input)', async () => {
    const c = await seedComment('​​');
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([S({ spam: 0.99 })]);
    const r = await job(p).handle(ctx(c, 1), payload(c));
    expect(r).toMatchObject({ result: 'classified', outcome: null });
    expect(p.calls).toBe(0);
    const row = await one(
      `SELECT provider, model, scores FROM comment_classification WHERE comment_id = $1`,
      [c.id],
    );
    expect(row).toMatchObject({ provider: 'builtin', model: 'empty-input' });
    expect(Object.values(row.scores).every((v) => v === 0)).toBe(true);
  });

  it('emoji-only text with a high hate score is downgraded to flag; reason says why', async () => {
    const c = await seedComment('🤬🤬');
    await evaluateRules(c, 'no_match');
    const r = await job(new FakeProvider([S({ hate_speech: 0.99 }, 'und')])).handle(
      ctx(c, 1),
      payload(c),
    );
    expect(r.outcome).toBe('flag');
    expect(actions.request).not.toHaveBeenCalled();
    const row = await one(
      `SELECT downgraded, low_signal FROM comment_classification WHERE id = $1`,
      [r.classificationId],
    );
    expect(row).toEqual({ downgraded: 'low_signal', low_signal: true });
    const dec = await one(`SELECT outcome, reason FROM decision WHERE classification_id = $1`, [
      r.classificationId,
    ]);
    expect(dec.outcome).toBe('flag');
    expect(dec.reason).toContain('very short or emoji-only text');
  });

  it('unsupported language is recorded and never auto-hidden', async () => {
    const c = await seedComment('habari');
    await evaluateRules(c, 'no_match');
    const r = await job(new FakeProvider([S({ scam_phishing: 0.95 }, 'sw')]), {
      languages: ['en'],
    }).handle(ctx(c, 1), payload(c));
    expect(r.outcome).toBe('flag');
    expect(actions.request).not.toHaveBeenCalled();
    expect(
      await one(
        `SELECT language, language_supported, downgraded FROM comment_classification WHERE id = $1`,
        [r.classificationId],
      ),
    ).toEqual({ language: 'sw', language_supported: false, downgraded: 'unsupported_language' });
  });

  it('very long text: only the first 4000 chars are sent and truncation is recorded', async () => {
    const c = await seedComment('word '.repeat(2_000));
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([S()]);
    const r = await job(p).handle(ctx(c, 1), payload(c));
    expect(p.inputs[0]!.text.length).toBeLessThanOrEqual(4000);
    expect(p.inputs[0]!.truncated).toBe(true);
    expect(
      await one(`SELECT truncated, input_chars FROM comment_classification WHERE id = $1`, [
        r.classificationId,
      ]),
    ).toEqual({ truncated: true, input_chars: 10_000 });
  });

  it('brand over its in-flight cap defers (not a failure); another brand proceeds', async () => {
    const tenantA = await tenant();
    const tenantB = await tenant();
    const held = [await slots.acquire(tenantA.brandId), await slots.acquire(tenantA.brandId)];
    const a = await seedComment('busy', tenantA);
    await evaluateRules(a, 'no_match');
    const p = new FakeProvider([S()]);
    await expect(job(p).handle(ctx(a, 1), payload(a))).rejects.toBeInstanceOf(JobDeferral);
    expect(p.calls).toBe(0);
    expect(await count(`SELECT 1 FROM comment_classification WHERE comment_id = $1`, [a.id])).toBe(
      0,
    );
    const b = await seedComment('free', tenantB);
    await evaluateRules(b, 'no_match');
    expect((await job(new FakeProvider([S()])).handle(ctx(b, 1), payload(b))).result).toBe(
      'classified',
    );
    for (const h of held) await h!.release();
  });

  it('a job that waited longer than maxWaitMs is marked unclassified/queue_timeout instead of calling the provider', async () => {
    const c = await seedComment('waited');
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([S()]);
    const r = await job(p, { maxWaitMs: 1_000, clock: { now: () => 10_000 } }).handle(ctx(c, 1), {
      ...payload(c),
      requestedAt: 1,
    });
    expect(r.result).toBe('unclassified');
    expect(p.calls).toBe(0);
    expect(
      (
        await one(`SELECT unclassified_reason FROM comment_classification WHERE comment_id = $1`, [
          c.id,
        ])
      ).unclassified_reason,
    ).toBe('queue_timeout');
  });

  it('refused or failed actions fall back to a flag decision', async () => {
    const c = await seedComment('scam link');
    await evaluateRules(c, 'no_match');
    actions.request.mockResolvedValueOnce({ status: 'refused', code: 'unsupported' });
    const p = new FakeProvider([S({ scam_phishing: 0.9 })]);
    const r = await job(p).handle(ctx(c, 1), payload(c));
    expect(r).toMatchObject({ result: 'classified', outcome: 'hide', fallback: 'unsupported' });
    const flags = (
      await ctxDb.c.query(
        `SELECT reason FROM decision WHERE classification_id = $1 AND outcome = 'flag'`,
        [r.classificationId],
      )
    ).rows;
    expect(flags).toEqual([
      { reason: "Flagged for review: the classifier couldn't hide this comment (unsupported)." },
    ]);
    // a redelivery does not request or flag again
    const again = await job(p).handle(ctx(c, 1), payload(c));
    expect(again).toMatchObject({ fallback: 'recorded' });
    expect(actions.request).toHaveBeenCalledTimes(1);
    expect(
      await count(`SELECT 1 FROM decision WHERE classification_id = $1 AND outcome = 'flag'`, [
        r.classificationId,
      ]),
    ).toBe(1);
  });

  it('a recorded not_eligible action falls back with its outcome code', async () => {
    const c = await seedComment('scam again');
    await evaluateRules(c, 'no_match');
    actions.request.mockResolvedValueOnce({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'too_old' },
    });
    const r = await job(new FakeProvider([S({ scam_phishing: 0.9 })])).handle(
      ctx(c, 1),
      payload(c),
    );
    expect(r.fallback).toBe('too_old');
  });

  it('an earlier classifier hide is undone when an edit no longer meets the threshold', async () => {
    const c = await seedComment('original abuse');
    await evaluateRules(c, 'no_match');
    const first = await job(new FakeProvider([S({ hate_speech: 0.95 })])).handle(
      ctx(c, 1),
      payload(c),
    );
    await ctxDb.c.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
         request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'hide', 'classifier', $5, 'applied', now())`,
      [c.t.organizationId, c.t.brandId, c.t.connectionId, c.id, `clf:${first.classificationId}`],
    );
    await ctxDb.c.query(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [c.id]);
    const edited = await editComment(c, 'polite now');
    await evaluateRules(edited, 'no_match');
    actions.request.mockClear();
    const r = await job(new FakeProvider([S({ hate_speech: 0.1 })])).handle(
      ctx(edited, 1),
      payload(edited),
    );
    expect(r).toMatchObject({ result: 'classified', outcome: null, reversed: true });
    expect(actions.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unhide', requestKey: `clf:${r.classificationId}:unhide` }),
    );
    expect(
      await count(`SELECT 1 FROM decision WHERE comment_id = $1 AND outcome = 'approve'`, [c.id]),
    ).toBe(1);
  });

  async function hiddenByClassifier(body: string) {
    const c = await seedComment(body);
    await evaluateRules(c, 'no_match');
    const r1 = await job(new FakeProvider([S({ hate_speech: 0.95 })])).handle(
      ctx(c, 1),
      payload(c),
    );
    await ctxDb.c.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
         request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'hide', 'classifier', $5, 'applied', now())`,
      [c.t.organizationId, c.t.brandId, c.t.connectionId, c.id, `clf:${r1.classificationId}`],
    );
    await ctxDb.c.query(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [c.id]);
    return c;
  }

  async function editAndReclassify(c: Seeded, body: string) {
    const edited = await editComment(c, body);
    await evaluateRules(edited, 'no_match');
    actions.request.mockClear();
    const r = await job(new FakeProvider([S({ hate_speech: 0.1 })])).handle(
      ctx(edited, 1),
      payload(edited),
    );
    return { edited, r };
  }

  it('edit that clears a classifier-hidden comment appends an approve decision with evidence', async () => {
    const c = await hiddenByClassifier('hateful v1');
    const { r } = await editAndReclassify(c, 'sorry, edited');
    expect(r).toMatchObject({ reversed: true });
    expect(actions.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'unhide', requestKey: `clf:${r.classificationId}:unhide` }),
    );
    const dec = await one(
      `SELECT outcome, category, confidence::text, threshold::text, reason FROM decision WHERE classification_id = $1`,
      [r.classificationId],
    );
    expect(dec).toMatchObject({
      outcome: 'approve',
      category: 'hate_speech',
      confidence: '0.1000',
      threshold: '0.8000',
    });
    expect(dec.reason).toBe('Unhidden: Hate speech now scores 0.10, below 0.80.');
  });

  it('does not unhide when the edit is only downgraded and still scores above the hide threshold', async () => {
    const c = await hiddenByClassifier('hateful v3');
    const edited = await editComment(c, '🤬🤬');
    await evaluateRules(edited, 'no_match');
    actions.request.mockClear();
    const r = await job(new FakeProvider([S({ hate_speech: 0.95 }, 'und')])).handle(
      ctx(edited, 1),
      payload(edited),
    );
    expect(r).toMatchObject({ outcome: 'flag' });
    expect(r.reversed).toBeUndefined();
    expect(actions.request).not.toHaveBeenCalled();
  });

  it('marks only the unhide decision as a reversal', async () => {
    const c = await hiddenByClassifier('hateful v4');
    const { r } = await editAndReclassify(c, 'sorry, edited again');
    const rows = await ctxDb.c.query(
      `SELECT outcome, reversal FROM decision WHERE comment_id = $1 ORDER BY sequence`,
      [c.id],
    );
    expect(rows.rows.filter((d) => d.reversal)).toHaveLength(1);
    expect(r.reversed).toBe(true);
  });

  it('does not unhide when a moderator acted after the classifier', async () => {
    const c = await hiddenByClassifier('hateful v2');
    await ctxDb.c.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
         actor_user_id, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'hide', 'user', $5, $6, 'applied', now() + interval '1 second')`,
      [c.t.organizationId, c.t.brandId, c.t.connectionId, c.id, c.t.userId, `user:${randomUUID()}`],
    );
    const { r } = await editAndReclassify(c, 'sorry, edited again');
    expect(r.reversed).toBeUndefined();
    expect(actions.request).not.toHaveBeenCalled();
    expect(
      await count(`SELECT 1 FROM decision WHERE comment_id = $1 AND outcome = 'approve'`, [c.id]),
    ).toBe(0);
  });

  const rerun = (c: Seeded, p: ClassifierProvider) =>
    job(p).handle(ctx(c, 1), { ...payload(c), trigger: `rerun:${randomUUID()}` });
  const moderatorAction = (c: Seeded, kind: 'hide' | 'unhide') =>
    ctxDb.c.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
         actor_user_id, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, 'applied', now() + interval '1 second')`,
      [
        c.t.organizationId,
        c.t.brandId,
        c.t.connectionId,
        c.id,
        kind,
        c.t.userId,
        `user:${randomUUID()}`,
      ],
    );

  it('a re-run unhides a classifier hide once the current thresholds no longer hide it', async () => {
    const c = await hiddenByClassifier('hateful v5');
    await setThreshold(c.t, 'hate_speech', 0.8, 'flag');
    const p = new FakeProvider([S({ hate_speech: 0.95 })]);
    actions.request.mockClear();
    const r = await rerun(c, p);
    expect(r).toMatchObject({ result: 'classified', outcome: 'flag', reversed: true });
    expect(p.calls).toBe(0);
    expect(actions.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unhide', requestKey: `clf:${r.classificationId}:unhide` }),
    );
    const dec = await one(
      `SELECT outcome, category, confidence::text, threshold::text, reason FROM decision
       WHERE classification_id = $1 AND outcome = 'approve'`,
      [r.classificationId],
    );
    expect(dec).toMatchObject({
      category: 'hate_speech',
      confidence: '0.9500',
      threshold: '0.8000',
    });
    expect(dec.reason).toContain('Unhidden');
  });

  it('a re-run does not unhide when a moderator acted after the classifier', async () => {
    const c = await hiddenByClassifier('hateful v6');
    await moderatorAction(c, 'hide');
    await setThreshold(c.t, 'hate_speech', 0.8, 'flag');
    actions.request.mockClear();
    const r = await rerun(c, new FakeProvider([S({ hate_speech: 0.95 })]));
    expect(r.reversed).toBeUndefined();
    expect(actions.request).not.toHaveBeenCalled();
    expect(
      await count(`SELECT 1 FROM decision WHERE comment_id = $1 AND outcome = 'approve'`, [c.id]),
    ).toBe(0);
  });

  it('a re-run does not hide again a comment a moderator restored', async () => {
    const c = await hiddenByClassifier('hateful v7');
    await moderatorAction(c, 'unhide');
    await ctxDb.c.query(`UPDATE comment SET platform_state = 'visible' WHERE id = $1`, [c.id]);
    actions.request.mockClear();
    const r = await rerun(c, new FakeProvider([S({ hate_speech: 0.95 })]));
    expect(r).toMatchObject({ result: 'classified', outcome: 'flag' });
    expect(actions.request).not.toHaveBeenCalled();
    const dec = await one(`SELECT outcome, reason FROM decision WHERE classification_id = $1`, [
      r.classificationId,
    ]);
    expect(dec.outcome).toBe('flag');
    expect(dec.reason).toContain('moderator already acted');
  });

  it('ingest-triggered classification still hides after earlier moderator activity', async () => {
    const c = await seedComment('hateful v8');
    await evaluateRules(c, 'no_match');
    await moderatorAction(c, 'unhide');
    const r = await job(new FakeProvider([S({ hate_speech: 0.95 })])).handle(ctx(c, 1), payload(c));
    expect(r.outcome).toBe('hide');
    expect(actions.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hide' }));
  });

  it('does not unhide a comment hidden by a rule', async () => {
    const c = await seedComment('rule hidden');
    await evaluateRules(c, 'no_match');
    await ctxDb.c.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
         rule_id, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'hide', 'rule', $5, $6, 'applied', now())`,
      [
        c.t.organizationId,
        c.t.brandId,
        c.t.connectionId,
        c.id,
        c.t.ruleId,
        `rule-eval:${randomUUID()}`,
      ],
    );
    await ctxDb.c.query(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [c.id]);
    const { r } = await editAndReclassify(c, 'cleaned up');
    expect(r.reversed).toBeUndefined();
    expect(actions.request).not.toHaveBeenCalled();
  });

  it('a replayed reversal appends one approve decision only', async () => {
    const c = await hiddenByClassifier('hateful v3');
    const edited = await editComment(c, 'now polite');
    await evaluateRules(edited, 'no_match');
    actions.request.mockClear();
    const p = new FakeProvider([S({ hate_speech: 0.1 })]);
    const r1 = await job(p).handle(ctx(edited, 1), payload(edited));
    const r2 = await job(p).handle(ctx(edited, 1), payload(edited));
    expect(r2.classificationId).toBe(r1.classificationId);
    expect(
      await count(`SELECT 1 FROM decision WHERE comment_id = $1 AND outcome = 'approve'`, [c.id]),
    ).toBe(1);
    expect(new Set(actions.request.mock.calls.map((x) => x[0].requestKey))).toEqual(
      new Set([`clf:${r1.classificationId}:unhide`]),
    );
  });

  it('without a rule evaluation on ingest the job fails retryably and records nothing', async () => {
    const c = await seedComment('too early');
    const p = new FakeProvider([S({ spam: 0.99 })]);
    await expect(job(p).handle(ctx(c, 1), payload(c))).rejects.toMatchObject({
      kind: 'retryable',
      code: 'rule_evaluation_pending',
    });
    expect(p.calls).toBe(0);
    expect(await count(`SELECT 1 FROM comment_classification WHERE comment_id = $1`, [c.id])).toBe(
      0,
    );
    expect(actions.request).not.toHaveBeenCalled();
  });

  it('a skipped rule evaluation records rules_not_evaluated with no action or decision', async () => {
    const c = await seedComment('skipped upstream');
    await evaluateRules(c, 'skipped');
    const p = new FakeProvider([S({ hate_speech: 0.99 })]);
    const r = await job(p).handle(ctx(c, 1), payload(c));
    expect(r).toMatchObject({ result: 'skipped' });
    expect(p.calls).toBe(0);
    expect(
      (await one(`SELECT skip_reason FROM comment_classification WHERE comment_id = $1`, [c.id]))
        .skip_reason,
    ).toBe('rules_not_evaluated');
    expect(actions.request).not.toHaveBeenCalled();
    expect(await count(`SELECT 1 FROM decision WHERE comment_id = $1`, [c.id])).toBe(0);
  });

  it('releases the brand slot after a provider failure', async () => {
    const c = await seedComment('fails then frees');
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([new ClassifierProviderError('timeout', true)]);
    await expect(job(p).handle(ctx(c, 1), payload(c))).rejects.toMatchObject({ kind: 'retryable' });
    await job(p).handle(ctx(c, 3), payload(c));
    const a = await slots.acquire(c.t.brandId);
    const b = await slots.acquire(c.t.brandId);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it('defers with a fixed retry delay when the brand is at its cap', async () => {
    const t = await tenant();
    const held = [await slots.acquire(t.brandId), await slots.acquire(t.brandId)];
    const c = await seedComment('busy delay', t);
    await evaluateRules(c, 'no_match');
    await expect(job(new FakeProvider([S()])).handle(ctx(c, 1), payload(c))).rejects.toMatchObject({
      retryAfterMs: 30_000,
    });
    for (const h of held) await h!.release();
  });

  it('an accepted replay whose action already failed falls back to a flag', async () => {
    const c = await seedComment('replayed failure');
    await evaluateRules(c, 'no_match');
    actions.request.mockResolvedValueOnce({
      status: 'accepted',
      action: { status: 'failed', outcomeCode: 'enqueue_failed' },
    });
    const r = await job(new FakeProvider([S({ scam_phishing: 0.9 })])).handle(
      ctx(c, 1),
      payload(c),
    );
    expect(r.fallback).toBe('enqueue_failed');
    expect(
      await count(`SELECT 1 FROM decision WHERE classification_id = $1 AND outcome = 'flag'`, [
        r.classificationId,
      ]),
    ).toBe(1);
  });

  it('a comment from another connection scope is gone', async () => {
    const c = await seedComment('scoped');
    await evaluateRules(c, 'no_match');
    const other = await ctxDb.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'instagram', $3) RETURNING id`,
      [c.t.organizationId, c.t.brandId, `ig-${randomUUID()}`],
    );
    const p = new FakeProvider([S({ spam: 0.99 })]);
    expect(await job(p).handle(ctx(c, 1, other.rows[0]!.id), payload(c))).toEqual({
      result: 'gone',
    });
    const foreign = await tenant();
    expect(await job(p).handle(ctx({ ...c, t: foreign }, 1), payload(c))).toEqual({
      result: 'gone',
    });
    expect(p.calls).toBe(0);
  });
});

describe('comment_classify re-run semantics', () => {
  it('re-run reuses stored scores (no provider call) and applies current thresholds without rewriting the old decision', async () => {
    const t = await tenant();
    const c = await seedComment('maybe spam', t);
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([S({ spam: 0.7 })]);
    expect((await job(p).handle(ctx(c, 1), payload(c))).outcome).toBeNull();
    await setThreshold(t, 'spam', 0.6, 'flag');
    const r = await job(p).handle(ctx(c, 1), {
      ...payload(c),
      trigger: `rerun:${randomUUID()}`,
    });
    expect(r.outcome).toBe('flag');
    expect(p.calls).toBe(1);
    expect(await count(`SELECT 1 FROM comment_classification WHERE comment_id = $1`, [c.id])).toBe(
      2,
    );
  });

  it('a threshold change alone writes nothing; a later re-run appends one decision with no provider call', async () => {
    const t = await tenant();
    const c = await seedComment('maybe spam', t);
    await evaluateRules(c, 'no_match');
    const p = new FakeProvider([S({ spam: 0.7 })]);
    await job(p).handle(ctx(c, 1), payload(c));
    const decisions = `SELECT 1 FROM decision WHERE comment_id = $1`;
    const before = await count(decisions, [c.id]);
    await setThreshold(t, 'spam', 0.6, 'flag');
    expect(await count(decisions, [c.id])).toBe(before);
    expect(await count(`SELECT 1 FROM comment_classification WHERE comment_id = $1`, [c.id])).toBe(
      1,
    );
    await job(p).handle(ctx(c, 1), { ...payload(c), trigger: `rerun:${randomUUID()}` });
    expect(p.calls).toBe(1);
    expect(await count(decisions, [c.id])).toBe(before + 1);
  });

  it('re-run skips comments whose rules never ran (backfill)', async () => {
    const c = await seedComment('old backfilled comment');
    const p = new FakeProvider([S({ spam: 0.9 })]);
    const r = await job(p).handle(ctx(c, 1), {
      ...payload(c),
      trigger: `rerun:${randomUUID()}`,
    });
    expect(r.result).toBe('skipped');
    expect(p.calls).toBe(0);
    expect(
      (await one(`SELECT skip_reason FROM comment_classification WHERE comment_id = $1`, [c.id]))
        .skip_reason,
    ).toBe('rules_not_evaluated');
  });
});
