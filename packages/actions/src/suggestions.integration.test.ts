import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, uuid } from '@feedbouncer/db/testing';
import { REVIEW_GRACE_MS, graceEndsAt } from '@feedbouncer/connectors';
import { PgSuggestionStore, type SuggestionSourceInput } from './suggestions.js';
import type { GatedStep } from './suggestion-plan.js';
import { scopeOf, seedCommentRow } from './testing.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgSuggestionStore;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'actions-suggest-test', onIdleError: () => {} });
  store = new PgSuggestionStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const HIDE: GatedStep[] = [{ type: 'hide' }];
const DELETE: GatedStep[] = [{ type: 'delete', confirmIrreversible: true }];

const fresh = async () => {
  const t = await seedTenant(ctx.c, `sg${++n}`, { reviewMode: 'on' });
  await ctx.c.query("UPDATE rule SET mode = 'enforce' WHERE id = $1", [t.ruleId]);
  const comment = await seedCommentRow(ctx.c, t, 'buy now', { authorId: t.authorId });
  return { t, comment, scope: scopeOf(t), label: `sg${n}` };
};
type F = Awaited<ReturnType<typeof fresh>>;

const ruleSource = (f: F, ref = uuid()): SuggestionSourceInput => ({
  type: 'rule',
  ref,
  ruleId: f.t.ruleId,
  alsoMatchedRuleIds: [],
});
const propose = (
  f: F,
  source: SuggestionSourceInput,
  steps: readonly GatedStep[] = HIDE,
  commentId = f.comment.id,
) => store.propose(f.scope, { commentId, source, steps, reason: 'matched' });
const created = (r: Awaited<ReturnType<typeof propose>>) => {
  if (!('suggestionId' in r)) throw new Error(`skipped: ${r.skipped}`);
  return r;
};

describe('PgSuggestionStore', () => {
  it('propose twice for the same source is one suggestion with one source', async () => {
    const f = await fresh();
    const source = ruleSource(f);
    const a = created(await propose(f, source));
    const b = created(await propose(f, source));
    expect(a.created).toBe(true);
    expect(b).toEqual({ suggestionId: a.suggestionId, created: false });
    const view = await store.load(f.scope, a.suggestionId, new Date());
    expect(view).toMatchObject({ status: 'pending', commentBody: 'buy now', platform: 'facebook' });
    expect(view!.sources).toHaveLength(1);
    expect(view!.sources[0]).toMatchObject({ ruleName: 'Scam links', ruleLive: true });
    expect(view!.expiresAt).toBeInstanceOf(Date);
  });

  it('a source redelivered after its suggestion was decided writes nothing', async () => {
    const f = await fresh();
    const source = ruleSource(f);
    const a = created(await propose(f, source));
    await ctx.c.query(
      "UPDATE action_suggestion SET status = 'dismissed', status_reason = 'x', decided_at = now() WHERE id = $1",
      [a.suggestionId],
    );
    expect(await propose(f, source)).toEqual({ suggestionId: a.suggestionId, created: false });
    const rows = await ctx.c.query('SELECT status FROM action_suggestion WHERE comment_id = $1', [
      f.comment.id,
    ]);
    expect(rows.rows).toEqual([{ status: 'dismissed' }]);
  });

  it('rule and classifier sources on one comment share one suggestion', async () => {
    const f = await fresh();
    const a = created(await propose(f, ruleSource(f)));
    const b = created(await propose(f, { type: 'classifier', ref: uuid() }, DELETE));
    expect(b).toEqual({ suggestionId: a.suggestionId, created: false });
    const view = await store.load(f.scope, a.suggestionId, new Date());
    expect(view!.sources.map((s) => s.type)).toEqual(['rule', 'classifier']);
    expect(view!.plan.steps).toEqual(DELETE);
    expect(view!.plan.dropped).toEqual([{ type: 'hide', reason: 'hide_redundant_with_delete' }]);
  });

  it('edited body closes the old suggestion as comment_edited and opens a new one', async () => {
    const f = await fresh();
    const a = created(await propose(f, ruleSource(f)));
    await ctx.c.query("UPDATE comment SET body = 'buy now!!' WHERE id = $1", [f.comment.id]);
    const b = created(await propose(f, ruleSource(f)));
    expect(b.created).toBe(true);
    expect(b.suggestionId).not.toBe(a.suggestionId);
    expect(await store.load(f.scope, a.suggestionId, new Date())).toMatchObject({
      status: 'not_applicable',
      statusReason: 'comment_edited',
    });
    expect((await store.load(f.scope, b.suggestionId, new Date()))!.status).toBe('pending');
  });

  it('propose on a deleted comment → comment_gone', async () => {
    const f = await fresh();
    const gone = await seedCommentRow(ctx.c, f.t, 'x', { state: 'deleted' });
    expect(await propose(f, ruleSource(f), HIDE, gone.id)).toEqual({ skipped: 'comment_gone' });
    expect(await propose(f, ruleSource(f), HIDE, uuid())).toEqual({ skipped: 'comment_gone' });
    expect(await propose(f, ruleSource(f), [])).toEqual({ skipped: 'nothing_gated' });
  });

  it('propose for a disabled rule → rule_inactive', async () => {
    const f = await fresh();
    await ctx.c.query('UPDATE rule SET enabled = false WHERE id = $1', [f.t.ruleId]);
    expect(await propose(f, ruleSource(f))).toEqual({ skipped: 'rule_inactive' });
    await ctx.c.query("UPDATE rule SET enabled = true, mode = 'suggest' WHERE id = $1", [
      f.t.ruleId,
    ]);
    expect(await propose(f, ruleSource(f))).toEqual({ skipped: 'rule_inactive' });
  });

  it('effective status: deleted comment shows not_applicable without a write; past grace shows expired', async () => {
    const f = await fresh();
    const a = created(await propose(f, ruleSource(f)));
    await ctx.c.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [
      f.comment.id,
    ]);
    expect(await store.load(f.scope, a.suggestionId, new Date())).toMatchObject({
      status: 'not_applicable',
      statusReason: 'comment_gone',
    });
    const stored = await ctx.c.query('SELECT status FROM action_suggestion WHERE id = $1', [
      a.suggestionId,
    ]);
    expect(stored.rows[0].status).toBe('pending');

    const g = await fresh();
    const b = created(await propose(g, ruleSource(g)));
    const row = await ctx.c.query('SELECT review_mode_ends_at AS e FROM connection WHERE id = $1', [
      g.t.connectionId,
    ]);
    const grace = graceEndsAt({
      mode: 'on',
      startedAt: new Date(),
      endsAt: row.rows[0].e,
      endedAt: null,
    })!;
    expect(grace.getTime()).toBe(row.rows[0].e.getTime() + REVIEW_GRACE_MS);
    const before = new Date(grace.getTime() - 1);
    expect((await store.load(g.scope, b.suggestionId, before))!.status).toBe('pending');
    expect(await store.load(g.scope, b.suggestionId, grace)).toMatchObject({
      status: 'expired',
      statusReason: 'grace_period_ended',
      expiresAt: grace,
    });
    expect(await store.list(g.scope, { limit: 10 }, grace)).toHaveLength(0);
    expect(await store.list(g.scope, { status: 'expired', limit: 10 }, grace)).toHaveLength(1);
  });

  it('list filters by connection, rule, author, stepType and status', async () => {
    const f = await fresh();
    const other = await seedCommentRow(ctx.c, f.t, 'second', {});
    const a = created(await propose(f, ruleSource(f)));
    const b = created(await propose(f, { type: 'classifier', ref: uuid() }, DELETE, other.id));
    const now = new Date();
    const ids = async (x: Parameters<PgSuggestionStore['list']>[1]) =>
      (await store.list(f.scope, x, now)).map((v) => v.id);

    expect(await ids({ limit: 10 })).toEqual([b.suggestionId, a.suggestionId]);
    expect(await ids({ connectionId: f.t.connectionId, limit: 10 })).toHaveLength(2);
    expect(await ids({ connectionId: uuid(), limit: 10 })).toEqual([]);
    expect(await ids({ ruleId: f.t.ruleId, limit: 10 })).toEqual([a.suggestionId]);
    expect(await ids({ authorId: f.t.authorId, limit: 10 })).toEqual([a.suggestionId]);
    expect(await ids({ stepType: 'delete', limit: 10 })).toEqual([b.suggestionId]);
    expect(await ids({ before: b.suggestionId, limit: 10 })).toEqual([a.suggestionId]);
    expect(await ids({ limit: 1 })).toEqual([b.suggestionId]);

    await withTransaction(pool, (tx) =>
      store.decide(tx, f.scope, a.suggestionId, {
        status: 'dismissed',
        reason: null,
        userId: f.t.userId,
        requestKey: 'k1',
      }),
    );
    expect(await ids({ limit: 10 })).toEqual([b.suggestionId]);
    expect(await ids({ status: 'dismissed', limit: 10 })).toEqual([a.suggestionId]);
    expect(await ids({ status: 'all', limit: 10 })).toHaveLength(2);
    expect(await store.pendingCount(f.scope)).toBe(1);
    expect(await store.pendingCount(f.scope, f.t.connectionId)).toBe(1);
    expect(await store.pendingCount(f.scope, uuid())).toBe(0);
  });

  it('pendingAuthors groups repeat offenders', async () => {
    const f = await fresh();
    for (let i = 0; i < 2; i++) {
      const c = await seedCommentRow(ctx.c, f.t, `spam ${i}`, { authorId: f.t.authorId });
      created(await propose(f, ruleSource(f), HIDE, c.id));
    }
    const solo = await ctx.c.query<{ id: string }>(
      "INSERT INTO author (organization_id, brand_id, connection_id, external_id) VALUES ($1,$2,$3,'solo') RETURNING id",
      [f.t.organizationId, f.t.brandId, f.t.connectionId],
    );
    const c = await seedCommentRow(ctx.c, f.t, 'one', { authorId: solo.rows[0]!.id });
    created(await propose(f, ruleSource(f), HIDE, c.id));

    expect(await store.pendingAuthors(f.scope, f.t.connectionId, 10)).toEqual([
      { authorId: f.t.authorId, authorName: `Author ${f.label}`, pendingCount: 2 },
    ]);
    const views = await store.list(f.scope, { authorId: f.t.authorId, limit: 10 }, new Date());
    expect(views.map((v) => v.authorPendingCount)).toEqual([2, 2]);
  });

  it('onRuleChanged retired withdraws suggestions left with no source; actions change updates steps', async () => {
    const f = await fresh();
    const a = created(await propose(f, ruleSource(f)));
    const shared = await seedCommentRow(ctx.c, f.t, 'shared');
    const k = created(await propose(f, ruleSource(f), HIDE, shared.id));
    created(await propose(f, { type: 'classifier', ref: uuid() }, DELETE, shared.id));
    const now = new Date();

    const changed = await withTransaction(pool, (tx) =>
      store.onRuleChanged(tx, f.scope, f.t.ruleId, {
        actions: [{ type: 'flag_for_review' }, { type: 'auto_reply', template: 'hello' }],
      }),
    );
    expect(changed).toEqual({ withdrawn: 0, updated: 2 });
    expect((await store.load(f.scope, a.suggestionId, now))!.sources[0]!.steps).toEqual([
      { type: 'auto_reply', template: 'hello' },
    ]);

    const emptied = await withTransaction(pool, (tx) =>
      store.onRuleChanged(tx, f.scope, f.t.ruleId, { actions: [{ type: 'flag_for_review' }] }),
    );
    expect(emptied).toEqual({ withdrawn: 1, updated: 0 });
    expect(await store.load(f.scope, a.suggestionId, now)).toMatchObject({
      status: 'withdrawn',
      statusReason: 'rule_changed',
    });
    const kept = await store.load(f.scope, k.suggestionId, now);
    expect(kept).toMatchObject({ status: 'pending' });
    expect(kept!.sources.map((s) => s.type)).toEqual(['classifier']);

    const retired = await withTransaction(pool, (tx) =>
      store.onRuleChanged(tx, f.scope, f.t.ruleId, 'retired'),
    );
    expect(retired).toEqual({ withdrawn: 0, updated: 0 });
  });

  it('retired withdraws a suggestion whose only source was the rule', async () => {
    const f = await fresh();
    const a = created(await propose(f, ruleSource(f)));
    const retired = await withTransaction(pool, (tx) =>
      store.onRuleChanged(tx, f.scope, f.t.ruleId, 'retired'),
    );
    expect(retired).toEqual({ withdrawn: 1, updated: 0 });
    expect((await store.load(f.scope, a.suggestionId, new Date()))!.status).toBe('withdrawn');
  });

  it('lockForDecision returns the suggestion state; decide only while pending', async () => {
    const f = await fresh();
    const a = created(await propose(f, ruleSource(f)));
    const decide = () =>
      withTransaction(pool, async (tx) => {
        const locked = await store.lockForDecision(tx, f.scope, a.suggestionId);
        const ok = await store.decide(tx, f.scope, a.suggestionId, {
          status: 'approved',
          reason: null,
          userId: f.t.userId,
          requestKey: 'rk',
        });
        return { locked, ok };
      });
    const first = await decide();
    expect(first.ok).toBe(true);
    expect(first.locked).toMatchObject({
      status: 'pending',
      commentState: 'visible',
      bodyChanged: false,
      connectionStatus: 'active',
      connectionId: f.t.connectionId,
    });
    expect(first.locked!.reviewMode.mode).toBe('on');
    expect(first.locked!.sources[0]!.ruleCurrentGated).toEqual(HIDE);
    const second = await decide();
    expect(second.ok).toBe(false);
    expect(second.locked).toMatchObject({ status: 'approved', requestKey: 'rk' });
  });

  it('every method with brand B scope returns null/empty for brand A ids', async () => {
    const a = await fresh();
    const b = await fresh();
    const s = created(await propose(a, ruleSource(a)));
    const now = new Date();

    expect(await store.load(b.scope, s.suggestionId, now)).toBeNull();
    expect(await store.list(b.scope, { status: 'all', limit: 10 }, now)).toEqual([]);
    expect(
      await store.list(b.scope, { status: 'all', connectionId: a.t.connectionId, limit: 10 }, now),
    ).toEqual([]);
    expect(await store.pendingAuthors(b.scope, a.t.connectionId, 10)).toEqual([]);
    expect(await store.pendingCount(b.scope, a.t.connectionId)).toBe(0);
    expect(
      await withTransaction(pool, async (tx) => ({
        locked: await store.lockForDecision(tx, b.scope, s.suggestionId),
        decided: await store.decide(tx, b.scope, s.suggestionId, {
          status: 'dismissed',
          reason: null,
          userId: null,
          requestKey: null,
        }),
        rule: await store.onRuleChanged(tx, b.scope, a.t.ruleId, 'retired'),
      })),
    ).toEqual({ locked: null, decided: false, rule: { withdrawn: 0, updated: 0 } });
    expect(await propose(b, ruleSource(a), HIDE, a.comment.id)).toEqual({
      skipped: 'comment_gone',
    });
    expect((await store.load(a.scope, s.suggestionId, now))!.status).toBe('pending');
  });
});
