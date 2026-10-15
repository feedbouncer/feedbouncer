import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgPolicyStore, PolicyLimitError, PolicyNameTakenError } from './store.js';
import type { PolicyAction } from './types.js';

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgPolicyStore;
let t: Tenant;
let a: { organizationId: string; brandId: string };

const base: { name: string; text: string; action: PolicyAction; vague: boolean } = {
  name: 'No DMs',
  text: 'Hide comments telling people to DM another account',
  action: 'hide',
  vague: false,
};

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'policies-store-test', onIdleError: () => {} });
  store = new PgPolicyStore(pool);
  t = await seedTenant(db.c, 'store');
  a = { organizationId: t.organizationId, brandId: t.brandId };
});
afterAll(async () => {
  await pool.end();
  await db.close();
});

describe('PgPolicyStore', () => {
  it('creates a disabled policy with revision 1', async () => {
    const p = await withTransaction(pool, (c) => store.create(c, a, base, t.userId));
    expect(p).toMatchObject({
      name: 'No DMs',
      text: base.text,
      enabled: false,
      revision: 1,
      action: 'hide',
      vague: false,
      archived: false,
    });
    expect(await store.get(a, p.id)).toEqual(p);
    const revs = await store.revisions(a, p.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ id: p.revisionId, revision: 1, createdByUserId: t.userId });
  });

  it('editing text or action creates a new revision; name and enabled do not; earlier revisions are unchanged', async () => {
    const p = await withTransaction(pool, (c) =>
      store.create(c, a, { ...base, name: 'Edits' }, t.userId),
    );
    const r1 = p.revisionId;
    const renamed = await withTransaction(pool, (c) =>
      store.update(c, a, p.id, { name: 'Renamed' }, t.userId),
    );
    expect(renamed).toMatchObject({
      revised: false,
      enabledChanged: false,
      policy: { name: 'Renamed', revision: 1 },
    });
    const enabled = await withTransaction(pool, (c) =>
      store.update(c, a, p.id, { enabled: true }, t.userId),
    );
    expect(enabled).toMatchObject({
      revised: false,
      enabledChanged: true,
      policy: { enabled: true, revision: 1 },
    });
    const edited = await withTransaction(pool, (c) =>
      store.update(
        c,
        a,
        p.id,
        { text: 'Hide comments asking people to message another account' },
        t.userId,
      ),
    );
    expect(edited).toMatchObject({ revised: true, policy: { revision: 2 } });
    const sameText = await withTransaction(pool, (c) =>
      store.update(
        c,
        a,
        p.id,
        { text: '  Hide comments asking people to message another account ' },
        t.userId,
      ),
    );
    expect(sameText?.revised).toBe(false);
    const actionOnly = await withTransaction(pool, (c) =>
      store.update(c, a, p.id, { action: 'remove' }, t.userId),
    );
    expect(actionOnly).toMatchObject({ revised: true, policy: { revision: 3, action: 'remove' } });
    const revs = await store.revisions(a, p.id);
    expect(revs.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(revs.at(-1)).toMatchObject({ id: r1, text: base.text, action: 'hide' });
  });

  it('enforces 20 policies and 10 enabled per brand', async () => {
    const b = await seedTenant(db.c, 'limits');
    const bs = { organizationId: b.organizationId, brandId: b.brandId };
    const ids: string[] = [];
    for (let i = 0; i < 20; i++)
      ids.push(
        (
          await withTransaction(pool, (c) =>
            store.create(c, bs, { ...base, name: `p${i}` }, b.userId),
          )
        ).id,
      );
    const over = withTransaction(pool, (c) =>
      store.create(c, bs, { ...base, name: 'p20' }, b.userId),
    );
    await expect(over).rejects.toBeInstanceOf(PolicyLimitError);
    await expect(over).rejects.toMatchObject({ limit: 'policies', max: 20 });
    for (let i = 0; i < 10; i++)
      await withTransaction(pool, (c) => store.update(c, bs, ids[i]!, { enabled: true }, b.userId));
    await expect(
      withTransaction(pool, (c) => store.update(c, bs, ids[10]!, { enabled: true }, b.userId)),
    ).rejects.toMatchObject({ limit: 'enabled', max: 10 });
    // Re-enabling an already enabled policy at the cap is not a new enable.
    await expect(
      withTransaction(pool, (c) => store.update(c, bs, ids[0]!, { enabled: true }, b.userId)),
    ).resolves.toMatchObject({ enabledChanged: false });
    await withTransaction(pool, (c) => store.archive(c, bs, ids[0]!));
    await expect(
      withTransaction(pool, (c) => store.create(c, bs, { ...base, name: 'p20' }, b.userId)),
    ).resolves.toBeTruthy();
  });

  it('duplicate names raise PolicyNameTakenError', async () => {
    await withTransaction(pool, (c) => store.create(c, a, { ...base, name: 'Dup' }, t.userId));
    await expect(
      withTransaction(pool, (c) => store.create(c, a, { ...base, name: 'dup' }, t.userId)),
    ).rejects.toBeInstanceOf(PolicyNameTakenError);
    const other = await withTransaction(pool, (c) =>
      store.create(c, a, { ...base, name: 'Other' }, t.userId),
    );
    await expect(
      withTransaction(pool, (c) => store.update(c, a, other.id, { name: 'DUP' }, t.userId)),
    ).rejects.toBeInstanceOf(PolicyNameTakenError);
  });

  it('archive disables, hides from list and get, and keeps revisions', async () => {
    const p = await withTransaction(pool, (c) =>
      store.create(c, a, { ...base, name: 'ToArchive' }, t.userId),
    );
    await withTransaction(pool, (c) => store.update(c, a, p.id, { enabled: true }, t.userId));
    expect(await withTransaction(pool, (c) => store.archive(c, a, p.id))).toBe(true);
    expect(await withTransaction(pool, (c) => store.archive(c, a, p.id))).toBe(false);
    expect(await store.get(a, p.id)).toBeNull();
    expect((await store.list(a)).some((x) => x.id === p.id)).toBe(false);
    expect(await store.revisions(a, p.id)).toHaveLength(1);
    expect(
      await withTransaction(pool, (c) => store.update(c, a, p.id, { enabled: true }, t.userId)),
    ).toBeNull();
    // The name is free again once archived.
    await expect(
      withTransaction(pool, (c) => store.create(c, a, { ...base, name: 'ToArchive' }, t.userId)),
    ).resolves.toBeTruthy();
  });

  it('enabledForEvaluation returns current revisions in creation order; other brands are invisible', async () => {
    const b = await seedTenant(db.c, 'eval-order');
    const bs = { organizationId: b.organizationId, brandId: b.brandId };
    expect(await store.hasEnabled(bs)).toBe(false);
    const p1 = await withTransaction(pool, (c) =>
      store.create(c, bs, { ...base, name: 'first' }, b.userId),
    );
    const p2 = await withTransaction(pool, (c) =>
      store.create(c, bs, { ...base, name: 'second', action: 'flag' }, b.userId),
    );
    await withTransaction(pool, (c) =>
      store.create(c, bs, { ...base, name: 'third-disabled' }, b.userId),
    );
    await withTransaction(pool, (c) => store.update(c, bs, p2.id, { enabled: true }, b.userId));
    await withTransaction(pool, (c) =>
      store.update(
        c,
        bs,
        p1.id,
        { enabled: true, text: 'Hide comments that ask readers to DM someone else' },
        b.userId,
      ),
    );
    expect(await store.hasEnabled(bs)).toBe(true);
    const active = await store.enabledForEvaluation(bs);
    expect(active.map((x) => [x.name, x.revision])).toEqual([
      ['first', 2],
      ['second', 1],
    ]);
    expect(active[0]).toEqual({
      policyId: p1.id,
      revisionId: expect.any(String),
      revision: 2,
      name: 'first',
      text: 'Hide comments that ask readers to DM someone else',
      action: 'hide',
    });
    expect(await store.enabledForEvaluation(a)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ policyId: p1.id })]),
    );
    expect(await store.get(a, p1.id)).toBeNull();
    expect(await store.revisions(a, p1.id)).toEqual([]);
    expect(
      await withTransaction(pool, (c) => store.update(c, a, p1.id, { name: 'stolen' }, t.userId)),
    ).toBeNull();
    expect(await withTransaction(pool, (c) => store.archive(c, a, p1.id))).toBe(false);
    // A forged org with the right brand id is invisible too.
    const forged = { organizationId: t.organizationId, brandId: b.brandId };
    expect(await store.list(forged)).toEqual([]);
    expect(await store.hasEnabled(forged)).toBe(false);
  });

  it('forRun returns the run revision only while it is current and the policy is enabled', async () => {
    const b = await seedTenant(db.c, 'for-run');
    const bs = { organizationId: b.organizationId, brandId: b.brandId };
    const p = await withTransaction(pool, (c) =>
      store.create(c, bs, { ...base, name: 'run' }, b.userId),
    );
    await withTransaction(pool, (c) => store.update(c, bs, p.id, { enabled: true }, b.userId));
    const run = async (revisionId: string) =>
      (
        await db.c.query<{ id: string }>(
          `INSERT INTO policy_run (organization_id, brand_id, policy_id, revision_id, days, since)
           VALUES ($1, $2, $3, $4, 7, now() - interval '7 days') RETURNING id`,
          [bs.organizationId, bs.brandId, p.id, revisionId],
        )
      ).rows[0]!.id;
    const r1 = await run(p.revisionId);
    expect(await store.forRun(bs, r1)).toEqual({
      policyId: p.id,
      revisionId: p.revisionId,
      revision: 1,
      name: 'run',
      text: base.text,
      action: 'hide',
    });
    expect(await store.forRun(a, r1)).toBeNull();
    const edited = await withTransaction(pool, (c) =>
      store.update(c, bs, p.id, { text: 'Hide comments that sell followers' }, b.userId),
    );
    expect(await store.forRun(bs, r1)).toBeNull();
    const r2 = await run(edited!.policy.revisionId);
    expect(await store.forRun(bs, r2)).toMatchObject({ revision: 2 });
    await withTransaction(pool, (c) => store.update(c, bs, p.id, { enabled: false }, b.userId));
    expect(await store.forRun(bs, r2)).toBeNull();
    await withTransaction(pool, (c) => store.update(c, bs, p.id, { enabled: true }, b.userId));
    expect(await store.forRun(bs, r2)).toMatchObject({ revision: 2 });
    await withTransaction(pool, (c) => store.archive(c, bs, p.id));
    expect(await store.forRun(bs, r2)).toBeNull();
  });
});
