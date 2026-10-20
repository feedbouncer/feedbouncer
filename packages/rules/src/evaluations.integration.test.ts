import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgCommentStore } from '@feedbouncer/comments';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { PgEvaluationStore } from './evaluations.js';
import type { RuleAction, RuleHit, Verdict } from './types.js';
import { upsertStored } from '@feedbouncer/comments/testing';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let comments: PgCommentStore;
let store: PgEvaluationStore;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'rules-evaluations-test',
    onIdleError: () => {},
  });
  comments = new PgCommentStore(pool);
  store = new PgEvaluationStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const scopeOf = (t: Tenant): ConnectionScope => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  connectionId: t.connectionId,
});

async function fresh(): Promise<{ t: Tenant; scope: ConnectionScope; commentId: string }> {
  const t = await seedTenant(ctx.c, `ev${++n}`);
  const scope = scopeOf(t);
  const r = await upsertStored(
    comments,
    scope,
    {
      externalId: `c_${n}`,
      sourceExternalId: `post_${n}`,
      parentExternalId: null,
      author: { externalId: `a_${n}`, displayName: 'Someone', profileUrl: null },
      body: 'hello world',
      postedAt: new Date(),
      platformState: 'visible',
      permalink: null,
    },
    { ownAccountExternalId: 'page', syncedAt: new Date() },
  );
  return { t, scope, commentId: r.commentId };
}

async function rule(t: Tenant, name: string, action: RuleAction): Promise<string> {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, mode)
     VALUES ($1, $2, $3, '{"type":"keyword","terms":["x"]}', $4, 'enforce') RETURNING id`,
    [t.organizationId, t.brandId, name, action],
  );
  return r.rows[0]!.id;
}

const hit = (ruleId: string, ruleName: string, action: RuleAction): RuleHit => ({
  ruleId,
  ruleName,
  kind: 'keyword',
  action,
  actions: [],
  evidence: { kind: 'keyword', term: 'spam' },
});

const decisions = async (commentId: string) =>
  (
    await pool.query(
      `SELECT outcome, mode, actor_type, rule_id, reason, rule_evaluation_id
         FROM decision WHERE comment_id = $1 ORDER BY sequence`,
      [commentId],
    )
  ).rows;

async function decided(f: Awaited<ReturnType<typeof fresh>>, action: RuleAction = 'hide') {
  const suggestId = await rule(f.t, 'Dry hide', 'hide');
  const enforceId = await rule(f.t, 'Spam words', action);
  const verdict: Verdict = {
    suggestions: [hit(suggestId, 'Dry hide', 'hide')],
    alsoMatched: [],
    decided: hit(enforceId, 'Spam words', action),
    trace: [
      {
        ruleId: suggestId,
        mode: 'suggest',
        result: 'match',
        evidence: { kind: 'keyword', term: 'spam' },
      },
      {
        ruleId: enforceId,
        mode: 'enforce',
        result: 'match',
        evidence: { kind: 'keyword', term: 'spam' },
      },
    ],
  };
  const row = await store.record(f.scope, {
    commentId: f.commentId,
    sha: sha('hello world'),
    triggerKey: 'ingest',
    rulesetVersion: 'v1',
    status: 'decided',
    verdict,
  });
  return { row, suggestId, enforceId, verdict };
}

describe('PgEvaluationStore.record', () => {
  it('inserts the evaluation and its decisions, suggestions first then the enforce decision', async () => {
    const f = await fresh();
    const { row, suggestId, enforceId } = await decided(f);
    expect(row).toMatchObject({
      status: 'decided',
      matchedRuleId: enforceId,
      outcome: 'hide',
      fallbackAt: null,
    });
    const ev = (
      await pool.query(
        `SELECT connection_id, trigger_key, ruleset_version, trace, body_sha256 FROM rule_evaluation WHERE id = $1`,
        [row!.id],
      )
    ).rows[0];
    expect(ev.connection_id).toBe(f.scope.connectionId);
    expect(ev.trigger_key).toBe('ingest');
    expect(ev.ruleset_version).toBe('v1');
    expect(ev.trace).toHaveLength(2);
    expect(Buffer.compare(ev.body_sha256, sha('hello world'))).toBe(0);
    const ds = await decisions(f.commentId);
    expect(ds).toEqual([
      {
        outcome: 'hide',
        mode: 'suggest',
        actor_type: 'rule',
        rule_id: suggestId,
        reason: 'Rule "Dry hide" (keyword): matched "spam".',
        rule_evaluation_id: row!.id,
      },
      {
        outcome: 'hide',
        mode: 'enforce',
        actor_type: 'rule',
        rule_id: enforceId,
        reason: 'Rule "Spam words" (keyword): matched "spam".',
        rule_evaluation_id: row!.id,
      },
    ]);
  });

  it('returns null for a second record of the same key and adds no decisions', async () => {
    const f = await fresh();
    const first = await decided(f);
    const again = await store.record(f.scope, {
      commentId: f.commentId,
      sha: sha('hello world'),
      triggerKey: 'ingest',
      rulesetVersion: 'v2',
      status: 'decided',
      verdict: first.verdict,
    });
    expect(again).toBeNull();
    expect(await decisions(f.commentId)).toHaveLength(2);
    expect(await store.find(f.scope, f.commentId, sha('hello world'), 'ingest')).toEqual(first.row);
  });

  it('records skipped and no_match without decisions', async () => {
    const f = await fresh();
    const s = await store.record(f.scope, {
      commentId: f.commentId,
      sha: sha('a'),
      triggerKey: 'ingest',
      rulesetVersion: '-',
      status: 'skipped',
      skipReason: 'own_account',
    });
    expect(s).toMatchObject({ status: 'skipped', matchedRuleId: null, outcome: null });
    const nm = await store.record(f.scope, {
      commentId: f.commentId,
      sha: sha('b'),
      triggerKey: 'ingest',
      rulesetVersion: 'v',
      status: 'no_match',
      verdict: { decided: null, suggestions: [], alsoMatched: [], trace: [] },
    });
    expect(nm).toMatchObject({ status: 'no_match' });
    expect(await decisions(f.commentId)).toHaveLength(0);
  });

  it('does not record a comment of another connection or tenant', async () => {
    const a = await fresh();
    const b = await fresh();
    const r = await store.record(b.scope, {
      commentId: a.commentId,
      sha: sha('x'),
      triggerKey: 'ingest',
      rulesetVersion: 'v',
      status: 'no_match',
      verdict: { decided: null, suggestions: [], alsoMatched: [], trace: [] },
    });
    expect(r).toBeNull();
    const other = await ctx.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'instagram', $3) RETURNING id`,
      [a.t.organizationId, a.t.brandId, `ig-${n}`],
    );
    const r2 = await store.record(
      { ...a.scope, connectionId: other.rows[0]!.id },
      {
        commentId: a.commentId,
        sha: sha('x'),
        triggerKey: 'ingest',
        rulesetVersion: 'v',
        status: 'no_match',
        verdict: { decided: null, suggestions: [], alsoMatched: [], trace: [] },
      },
    );
    expect(r2).toBeNull();
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM rule_evaluation WHERE comment_id = $1',
      [a.commentId],
    );
    expect(count.rows[0].n).toBe(0);
  });
});

describe('PgEvaluationStore fallback', () => {
  it('recordFallback is exactly-once and appends one flag decision', async () => {
    const f = await fresh();
    const { row, enforceId } = await decided(f);
    const info = await store.loadForFallback(f.scope, row!.id);
    expect(info).toEqual({
      ruleId: enforceId,
      ruleName: 'Spam words',
      platform: 'facebook',
      outcome: 'hide',
      commentId: f.commentId,
    });
    expect(await store.recordFallback(f.scope, row!.id, 'unsupported', 'Flagged for review')).toBe(
      true,
    );
    expect(await store.recordFallback(f.scope, row!.id, 'failed', 'again')).toBe(false);
    const flags = (await decisions(f.commentId)).filter((d) => d.outcome === 'flag');
    expect(flags).toEqual([
      {
        outcome: 'flag',
        mode: 'enforce',
        actor_type: 'rule',
        rule_id: enforceId,
        reason: 'Flagged for review',
        rule_evaluation_id: row!.id,
      },
    ]);
    const ev = await store.find(f.scope, f.commentId, sha('hello world'), 'ingest');
    expect(ev?.fallbackAt).toBeInstanceOf(Date);
    const code = await pool.query('SELECT fallback_code FROM rule_evaluation WHERE id = $1', [
      row!.id,
    ]);
    expect(code.rows[0].fallback_code).toBe('unsupported');
  });

  it('recordRecovered works only after a fallback, and only once', async () => {
    const f = await fresh();
    const { row, enforceId } = await decided(f);
    expect(await store.recordRecovered(f.scope, row!.id, 'Hidden after all')).toBe(false);
    await store.recordFallback(f.scope, row!.id, 'rate_limited', 'Flagged');
    expect(await store.recordRecovered(f.scope, row!.id, 'Hidden after all')).toBe(true);
    expect(await store.recordRecovered(f.scope, row!.id, 'Hidden after all')).toBe(false);
    const ds = await decisions(f.commentId);
    expect(ds.map((d) => [d.outcome, d.mode])).toEqual([
      ['hide', 'suggest'],
      ['hide', 'enforce'],
      ['flag', 'enforce'],
      ['hide', 'enforce'],
    ]);
    expect(ds[3]).toMatchObject({ rule_id: enforceId, reason: 'Hidden after all' });
  });

  it('every method is tenant scoped', async () => {
    const a = await fresh();
    const b = await fresh();
    const { row } = await decided(a);
    expect(await store.find(b.scope, a.commentId, sha('hello world'), 'ingest')).toBeNull();
    expect(await store.loadForFallback(b.scope, row!.id)).toBeNull();
    expect(await store.recordFallback(b.scope, row!.id, 'unsupported', 'x')).toBe(false);
    await store.recordFallback(a.scope, row!.id, 'unsupported', 'x');
    expect(await store.recordRecovered(b.scope, row!.id, 'y')).toBe(false);
    const ev = (
      await pool.query('SELECT fallback_code, recovered_at FROM rule_evaluation WHERE id = $1', [
        row!.id,
      ])
    ).rows[0];
    expect(ev).toEqual({ fallback_code: 'unsupported', recovered_at: null });
    expect(await decisions(a.commentId)).toHaveLength(3);
    expect(await decisions(b.commentId)).toHaveLength(0);
  });

  it('does not fall back an evaluation that decided nothing', async () => {
    const f = await fresh();
    const nm = await store.record(f.scope, {
      commentId: f.commentId,
      sha: sha('z'),
      triggerKey: 'ingest',
      rulesetVersion: 'v',
      status: 'no_match',
      verdict: { decided: null, suggestions: [], alsoMatched: [], trace: [] },
    });
    expect(await store.loadForFallback(f.scope, nm!.id)).toBeNull();
    expect(await store.recordFallback(f.scope, nm!.id, 'unsupported', 'x')).toBe(false);
  });
});
