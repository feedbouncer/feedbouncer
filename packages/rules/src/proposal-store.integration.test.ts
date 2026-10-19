import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, isUniqueViolation, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, uuid, type Tenant } from '@feedbouncer/db/testing';
import { effectiveStatus, PgRuleProposalStore, type NewProposal } from './proposal-store.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
const store = new PgRuleProposalStore();
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'proposal-store-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
async function seedKey(t: Tenant): Promise<string> {
  const publicId = Array.from(randomBytes(16), (b) => BASE32[b % 32]).join('');
  const { rows } = await ctx.c.query<{ id: string }>(
    `INSERT INTO api_key (organization_id, name, public_id, secret_sha256, scope)
     VALUES ($1, $2, $3, $4, 'write') RETURNING id`,
    [t.organizationId, `key ${publicId}`, publicId, randomBytes(32)],
  );
  return rows[0]!.id;
}

const after = {
  name: 'Spam',
  conditions: { type: 'keyword', terms: ['spam'] },
  actions: [{ type: 'hide' }],
  mode: 'enforce',
  enabled: true,
};
const proposal = (t: Tenant, apiKeyId: string, over: Partial<NewProposal> = {}): NewProposal => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  operation: 'create',
  targetRuleId: null,
  before: null,
  after,
  diff: [{ field: 'name', before: undefined, after: 'Spam' }],
  warnings: [],
  rationale: 'Too much spam',
  baseRuleRevision: 3,
  proposedByApiKeyId: apiKeyId,
  requestKey: `api:${apiKeyId}:${uuid()}`,
  ttlHours: 24,
  ...over,
});

const fresh = async () => {
  const t = await seedTenant(ctx.c, `ps${++n}`);
  return { t, key: await seedKey(t) };
};

describe('PgRuleProposalStore', () => {
  it('create + get round-trip', async () => {
    const { t, key } = await fresh();
    const created = await withTransaction(pool, (tx) => store.create(tx, proposal(t, key)));
    const got = await store.get(pool, t.organizationId, created.id);
    expect(got).toEqual(created);
    expect(got).toMatchObject({
      organizationId: t.organizationId,
      brandId: t.brandId,
      operation: 'create',
      targetRuleId: null,
      before: null,
      after,
      warnings: [],
      rationale: 'Too much spam',
      baseRuleRevision: 3,
      proposedByApiKeyId: key,
      status: 'pending',
      decidedByUserId: null,
      decidedAt: null,
      appliedRuleId: null,
    });
    expect(got!.expiresAt.getTime() - got!.createdAt.getTime()).toBe(24 * 3_600_000);
    expect(effectiveStatus(got!)).toBe('pending');

    const other = await fresh();
    expect(await store.get(pool, other.t.organizationId, created.id)).toBeNull();
    const listed = await store.list(pool, t.organizationId, t.brandId, { statuses: ['pending'] });
    expect(listed.map((p) => p.id)).toEqual([created.id]);
    expect(await store.list(pool, other.t.organizationId, t.brandId, {})).toEqual([]);
    expect(await withTransaction(pool, (tx) => store.countPending(tx, t.brandId))).toBe(1);
  });

  it('finds a pending duplicate of the same change and base revision only', async () => {
    const { t, key } = await fresh();
    const created = await withTransaction(pool, (tx) => store.create(tx, proposal(t, key)));
    const find = (operation: 'create' | 'update', a: unknown, base: number) =>
      withTransaction(pool, (tx) =>
        store.findPendingDuplicate(tx, t.brandId, operation, null, a, base),
      );
    // Key order does not matter: jsonb compares by value.
    expect((await find('create', { ...after, enabled: true, name: 'Spam' }, 3))?.id).toBe(
      created.id,
    );
    expect(await find('create', { ...after, name: 'Other' }, 3)).toBeNull();
    expect(await find('create', after, 4)).toBeNull();
  });

  it('effectiveStatus is expired after expires_at', async () => {
    const { t, key } = await fresh();
    const created = await withTransaction(pool, (tx) => store.create(tx, proposal(t, key)));
    await ctx.c.query(
      `UPDATE rule_change_proposal SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [created.id],
    );
    const got = await store.get(pool, t.organizationId, created.id);
    expect(got!.status).toBe('pending');
    expect(effectiveStatus(got!)).toBe('expired');
    const list = (statuses: ('pending' | 'expired')[]) =>
      store.list(pool, t.organizationId, t.brandId, { statuses });
    expect(await list(['pending'])).toEqual([]);
    expect((await list(['expired'])).map((p) => p.id)).toEqual([created.id]);
    expect(await withTransaction(pool, (tx) => store.countPending(tx, t.brandId))).toBe(0);
    expect(
      await withTransaction(pool, (tx) =>
        store.findPendingDuplicate(tx, t.brandId, 'create', null, after, 3),
      ),
    ).toBeNull();
  });

  it('request_key unique per org', async () => {
    const { t, key } = await fresh();
    const requestKey = `api:${key}:same`;
    await withTransaction(pool, (tx) => store.create(tx, proposal(t, key, { requestKey })));
    const dup = withTransaction(pool, (tx) => store.create(tx, proposal(t, key, { requestKey })));
    await expect(dup).rejects.toSatisfy((e) =>
      isUniqueViolation(e, 'rule_change_proposal_organization_id_request_key_key'),
    );
    const other = await fresh();
    await expect(
      withTransaction(pool, (tx) => store.create(tx, proposal(other.t, other.key, { requestKey }))),
    ).resolves.toMatchObject({ requestKey });
  });

  it('decides a pending proposal once and lists recently settled ones by since', async () => {
    const { t, key } = await fresh();
    const p = await withTransaction(pool, (tx) => store.create(tx, proposal(t, key)));
    await withTransaction(pool, (tx) =>
      store.decide(tx, p.id, {
        status: 'rejected',
        decidedByUserId: t.userId,
        decisionNote: 'No',
      }),
    );
    const got = await store.get(pool, t.organizationId, p.id, { forUpdate: true });
    expect(got).toMatchObject({
      status: 'rejected',
      decidedByUserId: t.userId,
      decisionNote: 'No',
    });
    expect(got!.decidedAt).toBeInstanceOf(Date);
    await expect(
      withTransaction(pool, (tx) => store.decide(tx, p.id, { status: 'expired' })),
    ).rejects.toThrow();

    const since = (d: Date) => store.list(pool, t.organizationId, t.brandId, { since: d });
    expect((await since(new Date(Date.now() - 60_000))).map((r) => r.id)).toEqual([p.id]);
    expect(await since(new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('rejects a decided status without a user, and a create with a target rule', async () => {
    const { t, key } = await fresh();
    await expect(
      withTransaction(pool, (tx) => store.create(tx, proposal(t, key, { targetRuleId: t.ruleId }))),
    ).rejects.toThrow(/check/);
    const p = await withTransaction(pool, (tx) => store.create(tx, proposal(t, key)));
    await expect(
      withTransaction(pool, (tx) => store.decide(tx, p.id, { status: 'approved' })),
    ).rejects.toThrow(/check/);
  });
});
