import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgHiddenTodayStore, listQuery } from './hidden-today.js';
import { scopeOf, seedCommentRow, seedSuggestionRow, type Seeded } from './testing.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgHiddenTodayStore;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'actions-hidden-today-test',
    onIdleError: () => {},
  });
  store = new PgHiddenTodayStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const NOON = new Date('2026-10-16T12:00:00Z');
const page = { before: null, limit: 100 };

const fresh = (timezone = 'UTC') => seedTenant(ctx.c, `ht${++n}`, { timezone });
const comment = (t: Tenant, body = 'spam', state = 'hidden') =>
  seedCommentRow(ctx.c, t, body, { state, authorId: t.authorId });

interface ActionOpts {
  kind?: 'hide' | 'unhide';
  actor?: 'user' | 'rule' | 'classifier' | 'policy' | 'system';
  status?: string;
  outcome?: string | null;
  at: string;
  userId?: string | null;
  ruleId?: string | null;
  reverses?: string | null;
  key?: string;
}
async function act(s: Seeded, o: ActionOpts): Promise<string> {
  const status = o.status ?? 'applied';
  const actor = o.actor ?? 'rule';
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
       actor_user_id, rule_id, request_key, status, outcome_code, reverses_action_id, completed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       CASE WHEN $10 = 'pending' THEN NULL ELSE $13::timestamptz END, $13::timestamptz) RETURNING id`,
    [
      s.t.organizationId,
      s.t.brandId,
      s.t.connectionId,
      s.id,
      o.kind ?? 'hide',
      actor,
      o.userId !== undefined ? o.userId : actor === 'user' ? s.t.userId : null,
      o.ruleId !== undefined ? o.ruleId : actor === 'rule' ? s.t.ruleId : null,
      o.key ?? `k-${randomUUID()}`,
      status,
      o.outcome ?? null,
      o.reverses ?? null,
      o.at,
    ],
  );
  return r.rows[0]!.id;
}
const hide = (s: Seeded, at: string, o: Partial<ActionOpts> = {}) => act(s, { at, ...o });
const unhide = (s: Seeded, reverses: string, at: string, o: Partial<ActionOpts> = {}) =>
  act(s, { kind: 'unhide', actor: 'user', reverses, at, ...o });

const explain = async (t: Tenant, now: Date) => {
  const { text, values } = listQuery([t.organizationId], now, page);
  const c = await pool.connect();
  try {
    await c.query('SET enable_seqscan = off');
    const r = await c.query<Record<'QUERY PLAN', string>>(`EXPLAIN ${text}`, values);
    return r.rows.map((x) => x['QUERY PLAN']).join('\n');
  } finally {
    await c.query('RESET enable_seqscan');
    c.release();
  }
};

const list = async (t: Tenant, now = NOON) =>
  (await store.list([t.organizationId], now, page)).items;

describe('PgHiddenTodayStore.list', () => {
  it('lists applied hides since local midnight newest first', async () => {
    const t = await fresh();
    const [a, b, old] = [await comment(t, 'a'), await comment(t, 'b'), await comment(t, 'old')];
    const idA = await hide(a, '2026-10-16T01:00:00Z');
    const idB = await hide(b, '2026-10-16T09:00:00Z');
    await hide(old, '2026-10-15T23:59:59Z');
    const items = await list(t);
    expect(items.map((i) => i.hideActionId)).toEqual([idB, idA]);
    expect(items[0]).toMatchObject({
      organizationId: t.organizationId,
      organizationName: `Org ht${n}`,
      brandId: t.brandId,
      brandName: `Brand ht${n}`,
      connectionId: t.connectionId,
      connectionStatus: 'active',
      platform: 'facebook',
      commentId: b.id,
      commentBody: 'b',
      commentState: 'hidden',
      authorName: `Author ht${n}`,
      hiddenAt: new Date('2026-10-16T09:00:00Z'),
      state: 'hidden',
      canUnhide: true,
      lastAttempt: null,
    });
  });

  it('excludes a 23:50 PDT hide from yesterday at 00:05 PDT and includes a 00:10 PDT hide until 23:59 PDT', async () => {
    const t = await fresh('America/Los_Angeles');
    const early = await comment(t, 'early');
    const late = await comment(t, 'late');
    await hide(early, '2026-10-16T06:50:00Z');
    const lateId = await hide(late, '2026-10-16T07:10:00Z');
    expect((await list(t, new Date('2026-10-16T06:55:00Z'))).map((i) => i.commentBody)).toEqual([
      'early',
    ]);
    expect(await list(t, new Date('2026-10-16T07:05:00Z'))).toEqual([]);
    expect((await list(t, new Date('2026-10-16T07:15:00Z'))).map((i) => i.hideActionId)).toEqual([
      lateId,
    ]);
    expect((await list(t, new Date('2026-10-17T06:59:00Z'))).map((i) => i.hideActionId)).toEqual([
      lateId,
    ]);
    expect(await list(t, new Date('2026-10-17T07:01:00Z'))).toEqual([]);
  });

  it('25-hour DST day in Europe/Berlin includes a 00:30 CEST hide at 23:50 CET', async () => {
    const t = await fresh('Europe/Berlin');
    const c = await comment(t);
    const id = await hide(c, '2026-10-24T22:30:00Z');
    const items = await list(t, new Date('2026-10-25T22:50:00Z'));
    expect(items.map((i) => i.hideActionId)).toEqual([id]);
    expect(await list(t, new Date('2026-10-25T23:01:00Z'))).toEqual([]);
  });

  it('each brand uses its own timezone', async () => {
    const a = await fresh('UTC');
    const b = await fresh('Asia/Tokyo');
    const ca = await comment(a);
    const cb = await comment(b);
    await hide(ca, '2026-10-15T23:00:00Z');
    await hide(cb, '2026-10-15T23:00:00Z');
    const now = new Date('2026-10-16T01:00:00Z');
    const res = await store.list([a.organizationId, b.organizationId], now, page);
    expect(res.items.map((i) => i.brandId)).toEqual([b.brandId]);
    expect(res.brands).toEqual(
      expect.arrayContaining([
        {
          organizationId: a.organizationId,
          brandId: a.brandId,
          brandName: `Brand ht${n - 1}`,
          timezone: 'UTC',
          timezoneSet: true,
          dayStart: new Date('2026-10-16T00:00:00Z'),
        },
        {
          organizationId: b.organizationId,
          brandId: b.brandId,
          brandName: `Brand ht${n}`,
          timezone: 'Asia/Tokyo',
          timezoneSet: true,
          dayStart: new Date('2026-10-15T15:00:00Z'),
        },
      ]),
    );
  });

  it('reports a brand that never set its timezone as UTC with timezoneSet false', async () => {
    const t = await seedTenant(ctx.c, `ht${++n}`);
    const res = await store.list([t.organizationId], NOON, page);
    expect(res.brands).toEqual([
      expect.objectContaining({ brandId: t.brandId, timezone: 'UTC', timezoneSet: false }),
    ]);
  });

  it('pending, failed, noop hides and dry-run steps and pending suggestions do not appear', async () => {
    const t = await fresh();
    for (const status of ['pending', 'failed', 'noop', 'not_eligible']) {
      await hide(await comment(t, status), '2026-10-16T08:00:00Z', { status });
    }
    const sim = await comment(t, 'simulated');
    const ev = await ctx.c.query<{ id: string }>(
      `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
         trigger_key, ruleset_version, status)
       VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'sim', 'v1', 'no_match') RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, sim.id],
    );
    const run = await ctx.c.query<{ id: string }>(
      `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id, rule_evaluation_id, dry_run)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, sim.id, t.ruleId, ev.rows[0]!.id],
    );
    await ctx.c.query(
      `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status, completed_at)
       VALUES ($1, $2, $3, 0, 'hide', '{}', 'simulated', now())`,
      [t.organizationId, t.brandId, run.rows[0]!.id],
    );
    await seedSuggestionRow(ctx.c, await comment(t, 'suggested'));
    expect(await list(t)).toEqual([]);
  });

  it('hidden then restored then hidden again by a person shows one row in state hidden with three history entries', async () => {
    const t = await fresh();
    const c = await comment(t);
    const h1 = await hide(c, '2026-10-16T01:00:00Z');
    await unhide(c, h1, '2026-10-16T02:00:00Z');
    const h2 = await hide(c, '2026-10-16T03:00:00Z', { actor: 'user' });
    const items = await list(t);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ hideActionId: h2, state: 'hidden', lastAttempt: null });
    expect(items[0]!.history.map((h) => [h.kind, h.actorType])).toEqual([
      ['hide', 'rule'],
      ['unhide', 'user'],
      ['hide', 'user'],
    ]);
    expect(items[0]!.history[2]).toMatchObject({
      status: 'applied',
      outcomeCode: null,
      at: new Date('2026-10-16T03:00:00Z'),
    });
  });

  it('limits history to the 10 newest entries, oldest first', async () => {
    const t = await fresh();
    const c = await comment(t);
    let last = await hide(c, '2026-10-16T00:00:00Z');
    for (let i = 1; i <= 7; i++) {
      await unhide(c, last, `2026-10-16T0${i}:00:00Z`);
      last = await hide(c, `2026-10-16T0${i}:30:00Z`);
    }
    const [item] = await list(t);
    expect(item!.history).toHaveLength(10);
    expect(item!.history[0]!.at).toEqual(new Date('2026-10-16T03:00:00Z'));
    expect(item!.history[9]!.at).toEqual(new Date('2026-10-16T07:30:00Z'));
  });

  describe('source and reason', () => {
    const decision = async (
      t: Tenant,
      s: Seeded,
      o: { actor: string; reason: string; ruleEvalId?: string; extra?: string; vals?: unknown[] },
    ) => {
      const cols = [
        'organization_id',
        'brand_id',
        'comment_id',
        'outcome',
        'mode',
        'actor_type',
        'reason',
      ];
      const vals: unknown[] = [
        t.organizationId,
        t.brandId,
        s.id,
        'hide',
        'enforce',
        o.actor,
        o.reason,
      ];
      await ctx.c.query(
        `INSERT INTO decision (${cols.join(',')}${o.extra ?? ''}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}${
          o.vals ? ',' + o.vals.map((_, i) => `$${vals.length + i + 1}`).join(',') : ''
        })`,
        [...vals, ...(o.vals ?? [])],
      );
    };
    const evaluation = async (t: Tenant, s: Seeded) =>
      (
        await ctx.c.query<{ id: string }>(
          `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
             trigger_key, ruleset_version, status)
           VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), $5, 'v1', 'no_match') RETURNING id`,
          [t.organizationId, t.brandId, t.connectionId, s.id, `t-${randomUUID()}`],
        )
      ).rows[0]!.id;

    it('rule hide shows the rule with its name and the decision reason', async () => {
      const t = await fresh();
      const s = await comment(t);
      const ev = await evaluation(t, s);
      await hide(s, '2026-10-16T05:00:00Z', { key: `rule-eval:${ev}` });
      await decision(t, s, {
        actor: 'rule',
        reason: 'Rule "Scam links" matched.',
        extra: ',rule_id,rule_evaluation_id',
        vals: [t.ruleId, ev],
      });
      const [item] = await list(t);
      expect(item).toMatchObject({
        source: { type: 'rule', ruleId: t.ruleId, ruleName: 'Scam links' },
        reason: 'Rule "Scam links" matched.',
        ruleStepId: null,
      });
    });

    it('rule hide through a run step links the step and its decision', async () => {
      const t = await fresh();
      const s = await comment(t);
      const ev = await evaluation(t, s);
      const id = await hide(s, '2026-10-16T05:00:00Z');
      const run = await ctx.c.query<{ id: string }>(
        `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id, rule_evaluation_id, dry_run)
         VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, s.id, t.ruleId, ev],
      );
      const step = await ctx.c.query<{ id: string }>(
        `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status,
           moderation_action_id, completed_at)
         VALUES ($1, $2, $3, 0, 'hide', '{}', 'succeeded', $4, now()) RETURNING id`,
        [t.organizationId, t.brandId, run.rows[0]!.id, id],
      );
      await decision(t, s, {
        actor: 'rule',
        reason: 'Because.',
        extra: ',rule_id,rule_evaluation_id',
        vals: [t.ruleId, ev],
      });
      const [item] = await list(t);
      expect(item).toMatchObject({ ruleStepId: step.rows[0]!.id, reason: 'Because.' });
    });

    it('a step undo newer than the reversing action is the last attempt', async () => {
      const t = await fresh();
      const s = await comment(t);
      const ev = await evaluation(t, s);
      const id = await hide(s, '2026-10-16T05:00:00Z');
      const run = await ctx.c.query<{ id: string }>(
        `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id, rule_evaluation_id, dry_run)
         VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, s.id, t.ruleId, ev],
      );
      const undo = await unhide(s, id, '2026-10-16T06:00:00Z', {
        status: 'failed',
        outcome: 'permission_denied',
      });
      const undo2 = await act(s, {
        kind: 'unhide',
        actor: 'user',
        at: '2026-10-16T07:00:00Z',
        key: `undo:${randomUUID()}`,
      });
      await ctx.c.query(
        `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status,
           moderation_action_id, undo_action_id, completed_at)
         VALUES ($1, $2, $3, 0, 'hide', '{}', 'succeeded', $4, $5, now())`,
        [t.organizationId, t.brandId, run.rows[0]!.id, id, undo2],
      );
      const [item] = await list(t);
      expect(item!.lastAttempt?.actionId).toBe(undo2);
      expect(undo).not.toBe(undo2);
    });

    it('classifier shows the category and the reason', async () => {
      const t = await fresh();
      const s = await comment(t);
      const cls = await ctx.c.query<{ id: string }>(
        `INSERT INTO comment_classification (organization_id, brand_id, connection_id, comment_id, body_sha256,
           trigger_key, status, skip_reason, input_chars)
         VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'skipped', 'deleted', 0) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, s.id],
      );
      const clsId = cls.rows[0]!.id;
      await hide(s, '2026-10-16T05:00:00Z', { actor: 'classifier', key: `clf:${clsId}` });
      await decision(t, s, {
        actor: 'classifier',
        reason: 'Looks like spam.',
        extra:
          ',classifier_provider,classifier_model,category,classification_id,confidence,threshold',
        vals: ['p', 'm', 'spam', clsId, 0.9, 0.8],
      });
      const [item] = await list(t);
      expect(item).toMatchObject({
        source: { type: 'classifier', category: 'spam' },
        reason: 'Looks like spam.',
      });
    });

    it('policy shows the policy name', async () => {
      const t = await fresh();
      const s = await comment(t);
      const pol = await ctx.c.query<{ id: string }>(
        `INSERT INTO custom_policy (organization_id, brand_id, name) VALUES ($1, $2, 'No promos') RETURNING id`,
        [t.organizationId, t.brandId],
      );
      const rev = await ctx.c.query<{ id: string }>(
        `INSERT INTO custom_policy_revision (organization_id, brand_id, policy_id, revision, text, action, vague)
         VALUES ($1, $2, $3, 1, 'No promotional content', 'hide', false) RETURNING id`,
        [t.organizationId, t.brandId, pol.rows[0]!.id],
      );
      const peId = await policyEvaluation(t, s);
      await hide(s, '2026-10-16T05:00:00Z', { actor: 'policy', key: `pol:${peId}` });
      await decision(t, s, {
        actor: 'policy',
        reason: 'Promo.',
        extra: ',policy_evaluation_id,policy_revision_id',
        vals: [peId, rev.rows[0]!.id],
      });
      const [item] = await list(t);
      expect(item).toMatchObject({
        source: { type: 'policy', policyId: pol.rows[0]!.id, policyName: 'No promos' },
        reason: 'Promo.',
      });
    });

    it('person shows the user name and a null reason; a deleted rule has no name', async () => {
      const t = await fresh();
      await ctx.c.query("UPDATE app_user SET display_name = 'Dana' WHERE id = $1", [t.userId]);
      const s = await comment(t);
      await hide(s, '2026-10-16T05:00:00Z', { actor: 'user' });
      const gone = await comment(t, 'gone rule');
      await hide(gone, '2026-10-16T04:00:00Z', { ruleId: null });
      const items = await list(t);
      expect(items[0]).toMatchObject({
        source: { type: 'person', userName: 'Dana' },
        reason: null,
      });
      expect(items[1]).toMatchObject({ source: { type: 'rule', ruleId: null, ruleName: null } });
    });

    it('approved suggestion shows the suggestion with the source reason', async () => {
      const t = await fresh();
      await ctx.c.query("UPDATE app_user SET display_name = 'Dana' WHERE id = $1", [t.userId]);
      const s = await comment(t);
      const sug = await seedSuggestionRow(ctx.c, s);
      for (const [i, reason] of ['First reason', 'Second reason'].entries()) {
        await ctx.c.query(
          `INSERT INTO action_suggestion_source (organization_id, brand_id, suggestion_id, source_type, source_ref,
             rule_id, steps, reason, created_at)
           VALUES ($1, $2, $3, 'rule', $4, $5, '[{"type":"hide"}]', $6, now() + $7 * interval '1 second')`,
          [t.organizationId, t.brandId, sug, randomUUID(), t.ruleId, reason, i],
        );
      }
      const id = await hide(s, '2026-10-16T05:00:00Z', { actor: 'user' });
      const run = await ctx.c.query<{ id: string }>(
        `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, suggestion_id, dry_run, approved_by_user_id)
         VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, s.id, sug, t.userId],
      );
      await ctx.c.query(
        `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status,
           moderation_action_id, completed_at)
         VALUES ($1, $2, $3, 0, 'hide', '{}', 'succeeded', $4, now())`,
        [t.organizationId, t.brandId, run.rows[0]!.id, id],
      );
      const [item] = await list(t);
      expect(item).toMatchObject({
        source: { type: 'suggestion', userName: 'Dana' },
        reason: 'First reason',
      });
    });

    const policyEvaluation = async (t: Tenant, s: Seeded) => {
      const r = await ctx.c.query<{ id: string }>(
        `INSERT INTO policy_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key,
           status, skip_reason)
         VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'skipped', 'deleted') RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, s.id],
      );
      return r.rows[0]!.id;
    };
  });

  describe('row state', () => {
    it('restored after an applied unhide reversing the hide', async () => {
      const t = await fresh();
      const c = await comment(t, 'x', 'visible');
      const h = await hide(c, '2026-10-16T01:00:00Z');
      const u = await unhide(c, h, '2026-10-16T02:00:00Z');
      const [item] = await list(t);
      expect(item).toMatchObject({ state: 'restored', canUnhide: false });
      expect(item!.lastAttempt).toEqual({
        actionId: u,
        status: 'applied',
        outcomeCode: null,
        createdAt: new Date('2026-10-16T02:00:00Z'),
        completedAt: new Date('2026-10-16T02:00:00Z'),
      });
    });
    it('already_visible after a noop already_visible', async () => {
      const t = await fresh();
      const c = await comment(t, 'x', 'visible');
      const h = await hide(c, '2026-10-16T01:00:00Z');
      await unhide(c, h, '2026-10-16T02:00:00Z', { status: 'noop', outcome: 'already_visible' });
      expect((await list(t))[0]).toMatchObject({ state: 'already_visible', canUnhide: false });
    });
    it('unavailable after the comment is deleted', async () => {
      const t = await fresh();
      const c = await comment(t, 'x', 'deleted');
      await hide(c, '2026-10-16T01:00:00Z');
      expect((await list(t))[0]).toMatchObject({ state: 'unavailable', canUnhide: false });
    });
    it('pending while the unhide is pending', async () => {
      const t = await fresh();
      const c = await comment(t);
      const h = await hide(c, '2026-10-16T01:00:00Z');
      await unhide(c, h, '2026-10-16T02:00:00Z', { status: 'pending' });
      expect((await list(t))[0]).toMatchObject({ state: 'pending', canUnhide: false });
    });
    it('failed after a failed unhide, and can be retried', async () => {
      const t = await fresh();
      const c = await comment(t);
      const h = await hide(c, '2026-10-16T01:00:00Z');
      await unhide(c, h, '2026-10-16T02:00:00Z', {
        status: 'failed',
        outcome: 'permission_denied',
      });
      expect((await list(t))[0]).toMatchObject({ state: 'failed', canUnhide: true });
    });
  });

  it('keyset pagination: 120 hides, pages of 50, 50, 20 with no duplicates or gaps, including equal completed_at', async () => {
    const t = await fresh();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const c = await comment(t, `c${i}`);
      ids.push(await hide(c, `2026-10-16T0${Math.floor(i / 20)}:00:00Z`));
    }
    const seen: string[] = [];
    const sizes: number[] = [];
    let before = null;
    for (;;) {
      const res: Awaited<ReturnType<typeof store.list>> = await store.list(
        [t.organizationId],
        NOON,
        {
          before,
          limit: 50,
        },
      );
      sizes.push(res.items.length);
      seen.push(...res.items.map((i) => i.hideActionId));
      if (!res.next) break;
      before = res.next;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('orgIds without the org returns nothing; archived brand excluded', async () => {
    const t = await fresh();
    const other = await fresh();
    await hide(await comment(t), '2026-10-16T05:00:00Z');
    expect((await store.list([other.organizationId], NOON, page)).items).toEqual([]);
    expect((await store.list([], NOON, page)).items).toEqual([]);
    await ctx.c.query('UPDATE brand SET archived_at = now() WHERE id = $1', [t.brandId]);
    const res = await store.list([t.organizationId], NOON, page);
    expect(res.items).toEqual([]);
    expect(res.brands).toEqual([]);
  });

  it('uses moderation_action_applied_hide_idx on a 10k-action seed', async () => {
    const t = await fresh();
    const c = await comment(t);
    await ctx.c.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
         request_key, status, completed_at, created_at)
       SELECT $1, $2, $3, $4, 'hide', 'rule', 'seed-' || g, 'applied',
              '2026-10-01T00:00:00Z'::timestamptz + g * interval '1 minute',
              '2026-10-01T00:00:00Z'::timestamptz + g * interval '1 minute'
         FROM generate_series(1, 10000) g`,
      [t.organizationId, t.brandId, t.connectionId, c.id],
    );
    await ctx.c.query('ANALYZE moderation_action');
    const now = new Date('2026-10-08T00:00:00Z');
    const plan = await explain(t, now);
    expect(plan).toContain('moderation_action_applied_hide_idx');
  });
});

describe('PgHiddenTodayStore.load', () => {
  it('loads a hide in its brand scope; another brand scope gets null', async () => {
    const a = await fresh();
    const b = await fresh();
    const c = await comment(a);
    const id = await hide(c, '2026-10-16T05:00:00Z');
    const item = await store.load(scopeOf(a), id, NOON);
    expect(item).toMatchObject({ hideActionId: id, commentId: c.id });
    expect(await store.load(scopeOf(b), id, NOON)).toBeNull();
    expect(
      await store.load({ organizationId: b.organizationId, brandId: a.brandId }, id, NOON),
    ).toBeNull();
  });

  it('returns null for a hide that is not the latest on its comment or not today', async () => {
    const t = await fresh();
    const c = await comment(t);
    const first = await hide(c, '2026-10-16T05:00:00Z');
    const second = await hide(c, '2026-10-16T06:00:00Z');
    expect(await store.load(scopeOf(t), first, NOON)).toBeNull();
    expect(await store.load(scopeOf(t), second, NOON)).not.toBeNull();
    expect(await store.load(scopeOf(t), second, new Date('2026-10-17T00:00:01Z'))).toBeNull();
    expect(await store.load(scopeOf(t), randomUUID(), NOON)).toBeNull();
  });

  it('does not load an unhide or a non-applied hide', async () => {
    const t = await fresh();
    const c = await comment(t);
    const pending = await hide(c, '2026-10-16T05:00:00Z', { status: 'pending' });
    expect(await store.load(scopeOf(t), pending, NOON)).toBeNull();
  });
});
