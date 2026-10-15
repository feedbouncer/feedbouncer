import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  DomainLimitError,
  MAX_DOMAINS_PER_BRAND,
  MAX_RULES_PER_BRAND,
  PgRuleStore,
  RuleLimitError,
} from './store.js';
import { ruleInputSchema, type RuleInput } from './conditions.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgRuleStore;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'rules-store-test', onIdleError: () => {} });
  store = new PgRuleStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const fresh = async (): Promise<{
  t: Tenant;
  scope: { organizationId: string; brandId: string };
}> => {
  const t = await seedTenant(ctx.c, `rs${++n}`);
  await ctx.c.query('UPDATE rule SET archived_at = now(), enabled = false WHERE brand_id = $1', [
    t.brandId,
  ]);
  return { t, scope: { organizationId: t.organizationId, brandId: t.brandId } };
};
const kw = (name: string, over: Partial<RuleInput> = {}): RuleInput =>
  ruleInputSchema.parse({
    name,
    conditions: { type: 'keyword', terms: [name] },
    action: 'hide',
    mode: 'enforce',
    ...over,
  });
const tx = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
};

describe('PgRuleStore rules', () => {
  it('appends at max(priority)+10 starting at 10 and derives kind', async () => {
    const { scope } = await fresh();
    const a = await tx((c) => store.create(c, scope, kw('alpha')));
    const b = await tx((c) => store.create(c, scope, kw('beta')));
    expect(a.priority).toBe(10);
    expect(b.priority).toBe(20);
    expect(a.kind).toBe('keyword');
    expect(a.conditions).toMatchObject({ type: 'keyword', terms: ['alpha'] });
    expect(a.enabled).toBe(true);
  });

  it('lists in evaluation order, hides archived, and isolates tenants', async () => {
    const { scope } = await fresh();
    const other = await fresh();
    const a = await tx((c) => store.create(c, scope, kw('alpha')));
    const b = await tx((c) => store.create(c, scope, kw('beta')));
    const c3 = await tx((c) => store.create(c, scope, kw('gamma')));
    expect(await tx((c) => store.archive(c, scope, b.id))).toBe(true);
    expect((await store.list(scope)).map((r) => r.id)).toEqual([a.id, c3.id]);
    expect(await store.get(scope, b.id)).toBeNull();

    expect(await store.get(other.scope, a.id)).toBeNull();
    expect(await tx((c) => store.update(c, other.scope, a.id, { name: 'x' }))).toBeNull();
    expect(await tx((c) => store.archive(c, other.scope, a.id))).toBe(false);
    expect(await tx((c) => store.reorder(c, other.scope, [a.id]))).toBe('mismatch');
    expect((await store.get(scope, a.id))?.name).toBe('alpha');
    expect(await store.list(other.scope)).toEqual([]);
  });

  it('enforces the rule limit and ignores archived rules', async () => {
    const { scope } = await fresh();
    await ctx.c.query(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action, priority)
       SELECT $1, $2, 'r' || g, '{"type":"keyword","terms":["x"],"match":"whole_word"}', 'flag', g
         FROM generate_series(1, $3) g`,
      [scope.organizationId, scope.brandId, MAX_RULES_PER_BRAND],
    );
    await expect(tx((c) => store.create(c, scope, kw('over')))).rejects.toBeInstanceOf(
      RuleLimitError,
    );
    const first = (await store.list(scope))[0]!;
    await tx((c) => store.archive(c, scope, first.id));
    await expect(tx((c) => store.create(c, scope, kw('fits')))).resolves.toBeDefined();
  });

  it('serialises concurrent creates at the limit', async () => {
    const { scope } = await fresh();
    await ctx.c.query(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action, priority)
       SELECT $1, $2, 'r' || g, '{"type":"keyword","terms":["x"],"match":"whole_word"}', 'flag', g
         FROM generate_series(1, $3) g`,
      [scope.organizationId, scope.brandId, MAX_RULES_PER_BRAND - 1],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => tx((c) => store.create(c, scope, kw(`c${i}`)))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.list(scope)).length).toBe(MAX_RULES_PER_BRAND);
  });

  it('archives a rule cited by a decision and keeps the decision joinable', async () => {
    const { t, scope } = await fresh();
    const r = await tx((c) => store.create(c, scope, kw('cited')));
    const cid = (
      await ctx.c.query(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
         VALUES ($1,$2,$3,$4,'ext-cited','hi', now()) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, t.sourceId],
      )
    ).rows[0].id;
    await ctx.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason)
       VALUES ($1,$2,$3,'hide','enforce','rule',$4,'matched')`,
      [t.organizationId, t.brandId, cid, r.id],
    );
    expect(await tx((c) => store.archive(c, scope, r.id))).toBe(true);
    const row = (
      await ctx.c.query(
        `SELECT r.name, r.enabled, r.archived_at FROM decision d
           JOIN rule r ON r.brand_id = d.brand_id AND r.id = d.rule_id WHERE d.comment_id = $1`,
        [cid],
      )
    ).rows[0];
    expect(row.name).toBe('cited');
    expect(row.enabled).toBe(false);
    expect(row.archived_at).not.toBeNull();
    expect(await tx((c) => store.archive(c, scope, r.id))).toBe(false);
  });

  it('reorders with exactly the active ids and rejects mismatches', async () => {
    const { scope } = await fresh();
    const a = await tx((c) => store.create(c, scope, kw('a1')));
    const b = await tx((c) => store.create(c, scope, kw('b1')));
    const c3 = await tx((c) => store.create(c, scope, kw('c1')));
    expect(await tx((c) => store.reorder(c, scope, [c3.id, a.id, b.id]))).toBe('ok');
    const list = await store.list(scope);
    expect(list.map((r) => [r.id, r.priority])).toEqual([
      [c3.id, 10],
      [a.id, 20],
      [b.id, 30],
    ]);
    const before = list.map((r) => r.id);
    const bad = [
      [a.id, b.id],
      [a.id, a.id, b.id],
      [a.id, b.id, c3.id, a.id],
      [a.id, b.id, '00000000-0000-4000-8000-000000000000'],
      [a.id, b.id, 'not-a-uuid'],
    ];
    for (const ids of bad) expect(await tx((c) => store.reorder(c, scope, ids))).toBe('mismatch');
    expect((await store.list(scope)).map((r) => r.id)).toEqual(before);
  });

  it('rejects an update whose merged action is invalid for the conditions', async () => {
    const { scope } = await fresh();
    const allow = await tx((c) =>
      store.create(
        c,
        scope,
        ruleInputSchema.parse({
          name: 'vip',
          conditions: {
            type: 'author',
            list: 'allow',
            platform: 'facebook',
            entries: [{ externalId: 'u1' }],
          },
          action: 'approve',
        }),
      ),
    );
    await expect(tx((c) => store.update(c, scope, allow.id, { action: 'hide' }))).rejects.toThrow(
      new TypeError('invalid_action_for_conditions'),
    );
    const ok = await tx((c) => store.update(c, scope, allow.id, { name: 'vips', enabled: false }));
    expect(ok).toMatchObject({ name: 'vips', enabled: false, action: 'approve' });
  });

  it('stores conditions as data, not SQL', async () => {
    const { scope } = await fresh();
    const evil = `'); DROP TABLE rule; --`;
    const r = await tx((c) =>
      store.create(
        c,
        scope,
        kw('inj', { conditions: { type: 'keyword', terms: [evil], match: 'contains' } }),
      ),
    );
    expect((await store.get(scope, r.id))?.conditions).toMatchObject({ terms: [evil] });
  });
});

describe('PgRuleStore own domains', () => {
  it('adds, dedups, scopes removal and enforces the limit', async () => {
    const { scope } = await fresh();
    const other = await fresh();
    const d = await tx((c) => store.addDomain(c, scope, 'example.com'));
    expect(d).not.toBe('exists');
    expect(await tx((c) => store.addDomain(c, scope, 'example.com'))).toBe('exists');
    const id = (d as { id: string }).id;
    expect(await tx((c) => store.removeDomain(c, other.scope, id))).toBe(false);
    expect(await store.listDomains(other.scope)).toEqual([]);
    expect((await store.listDomains(scope)).map((x) => x.domain)).toEqual(['example.com']);
    for (let i = 1; i < MAX_DOMAINS_PER_BRAND; i++)
      await tx((c) => store.addDomain(c, scope, `d${i}.example.com`));
    await expect(tx((c) => store.addDomain(c, scope, 'one-too-many.com'))).rejects.toBeInstanceOf(
      DomainLimitError,
    );
    expect(await tx((c) => store.addDomain(c, scope, 'example.com'))).toBe('exists');
    expect(await tx((c) => store.removeDomain(c, scope, id))).toBe(true);
  });
});

describe('PgRuleStore version and loadActive', () => {
  it('changes on every mutation and is stable otherwise', async () => {
    const { scope } = await fresh();
    const seen = [await store.version(scope)];
    expect(await store.version(scope)).toBe(seen[0]);
    const step = async (fn: () => Promise<unknown>) => {
      await fn();
      const v = await store.version(scope);
      // Each mutation must move the token; removing a domain restores the
      // pre-add state, which legitimately has the pre-add token.
      expect(v).not.toBe(seen[seen.length - 1]);
      seen.push(v);
      expect(await store.version(scope)).toBe(v);
    };
    let a!: { id: string };
    let b!: { id: string };
    await step(async () => (a = await tx((c) => store.create(c, scope, kw('v1')))));
    await step(async () => (b = await tx((c) => store.create(c, scope, kw('v2')))));
    await step(() => tx((c) => store.update(c, scope, a.id, { name: 'v1b' })));
    await step(() => tx((c) => store.reorder(c, scope, [b.id, a.id])));
    let dom!: { id: string };
    await step(
      async () =>
        (dom = (await tx((c) => store.addDomain(c, scope, 'x.example.com'))) as { id: string }),
    );
    await step(() => tx((c) => store.removeDomain(c, scope, dom.id)));
    await step(() => tx((c) => store.archive(c, scope, a.id)));
  });

  it('loads only enabled, non-archived rules plus own domains', async () => {
    const { scope } = await fresh();
    const on = await tx((c) => store.create(c, scope, kw('on')));
    await tx((c) => store.create(c, scope, kw('off', { enabled: false })));
    const gone = await tx((c) => store.create(c, scope, kw('gone')));
    await tx((c) => store.archive(c, scope, gone.id));
    await tx((c) => store.addDomain(c, scope, 'brand.example'));
    const loaded = await store.loadActive(scope);
    expect(loaded.records.map((r) => r.id)).toEqual([on.id]);
    expect(loaded.ownDomains).toEqual(['brand.example']);
    expect(loaded.version).toBe(await store.version(scope));
  });
});
