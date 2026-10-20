import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { open } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import type { SubjectIdentifierT } from '../subject/identifier.js';
import { PgPrivacyRequestStore, type NewPrivacyRequest } from './store.js';

const X = 'X-psid-3301';
const X_HANDLE = 'xavier.handle';
const keys = testKeyring();

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgPrivacyRequestStore;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'privacy-store-test', onIdleError: () => {} });
  store = new PgPrivacyRequestStore(pool, keys);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(async () => {
  await ctx.c.query('DELETE FROM organization');
  A = await seedTenant(ctx.c, 'a');
  B = await seedTenant(ctx.c, 'b');
});

const subjects: SubjectIdentifierT[] = [{ platform: 'facebook', externalId: X, handle: X_HANDLE }];
const request = (t: Tenant, o: Partial<NewPrivacyRequest> = {}): NewPrivacyRequest => ({
  organizationId: t.organizationId,
  kind: 'erasure',
  mode: 'execute',
  subjects,
  via: 'cli',
  actorUserId: null,
  actorLabel: 'ops-1',
  reference: 'TICKET-7',
  keepRuleEntriesReason: null,
  ...o,
});
const row = async (id: string) =>
  (await ctx.c.query('SELECT * FROM privacy_request WHERE id = $1', [id])).rows[0];
const audits = async (action: string) =>
  (await ctx.c.query('SELECT * FROM audit_event WHERE action = $1 ORDER BY sequence', [action]))
    .rows;

describe('PgPrivacyRequestStore', () => {
  it('seals the identifiers: the stored bytes contain neither the id nor the handle', async () => {
    const { id } = await store.create(request(A));
    const r = await row(id);
    expect(r.status).toBe('queued');
    expect(r.subject_count).toBe(1);
    const bytes = (r.subjects_sealed as Buffer).toString('latin1');
    expect(bytes).not.toContain(X);
    expect(bytes).not.toContain(X_HANDLE);
  });

  it('claims once, returns the opened subjects, and finish wipes them', async () => {
    const { id } = await store.create(request(A, { keepRuleEntriesReason: 'legal hold' }));
    const claimed = await store.claim(id);
    expect(claimed).toMatchObject({
      id,
      organizationId: A.organizationId,
      kind: 'erasure',
      mode: 'execute',
      subjects,
      keepRuleEntriesReason: 'legal hold',
    });
    expect((await row(id)).status).toBe('running');
    expect(await store.claim(id)).toBeNull();
    await store.finish(id, { found: true, counts: { comments: 3 }, coverage: 'c' });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'done', subjects_sealed: null, found: true, coverage: 'c' });
    expect(r.counts).toEqual({ comments: 3 });
    expect(await store.claim(id)).toBeNull();
  });

  it('releases a running request so the next attempt can claim it with its identifiers intact', async () => {
    const { id } = await store.create(request(A));
    await store.claim(id);
    await store.release(id);
    expect((await row(id)).status).toBe('queued');
    expect(await store.claim(id)).toMatchObject({ id, subjects });
    await store.finish(id, { found: false, counts: {}, coverage: 'c' });
    await store.release(id);
    expect((await row(id)).status).toBe('done');
  });

  it('reclaims a request left running for more than 15 minutes', async () => {
    const { id } = await store.create(request(A));
    await store.claim(id);
    await ctx.c.query(
      "UPDATE privacy_request SET started_at = now() - interval '16 minutes' WHERE id = $1",
      [id],
    );
    expect(await store.claim(id)).toMatchObject({ id, subjects });
  });

  it('records the export file on finish and a completion audit without identifiers', async () => {
    const { id } = await store.create(request(A, { kind: 'export' }));
    await store.claim(id);
    const sha256 = Buffer.alloc(32, 7);
    const expiresAt = new Date(Date.now() + 3_600_000);
    await store.finish(id, {
      found: true,
      counts: { comments: 2 },
      coverage: 'snapshot_at_generated_at',
      export: { bytes: 123, sha256, expiresAt },
    });
    await store.finish(id, { found: true, counts: {}, coverage: 'x' });
    const r = await row(id);
    expect(r.export_sha256).toEqual(sha256);
    expect(Number(r.export_bytes)).toBe(123);
    expect(r.export_expires_at).toEqual(expiresAt);
    const done = await audits('privacy.export_completed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      organization_id: A.organizationId,
      actor_type: 'system',
      subject_type: 'privacy_request',
      subject_id: id,
    });
    expect(done[0].details).toMatchObject({
      requestId: id,
      mode: 'execute',
      subjectCount: 1,
      found: true,
      counts: { comments: 2 },
      reference: 'TICKET-7',
    });
  });

  it.each([
    ['export', 'execute', 'privacy.export_completed'],
    ['erasure', 'dry_run', 'privacy.erasure_dry_run_completed'],
    ['erasure', 'execute', 'privacy.erasure_completed'],
  ] as const)('audits %s %s completion as %s', async (kind, mode, action) => {
    const { id } = await store.create(request(A, { kind, mode }));
    await store.claim(id);
    await store.finish(id, { found: false, counts: {}, coverage: 'c' });
    expect(await audits(action)).toHaveLength(1);
  });

  it('attributes an API request to its user', async () => {
    const userId = (
      await ctx.c.query<{ id: string }>(
        "INSERT INTO app_user (email) VALUES ('u@example.test') RETURNING id",
      )
    ).rows[0]!.id;
    const { id } = await store.create(
      request(A, { via: 'api', actorUserId: userId, actorLabel: null }),
    );
    const [requested] = await audits('privacy.erasure_requested');
    expect(requested).toMatchObject({ actor_type: 'user', actor_user_id: userId, subject_id: id });
  });

  it('writes a requested audit with the subject count and no identifier', async () => {
    const { id } = await store.create(request(A, { keepRuleEntriesReason: 'legal hold' }));
    const [a] = await audits('privacy.erasure_requested');
    expect(a.details).toMatchObject({
      requestId: id,
      mode: 'execute',
      subjectCount: 1,
      reference: 'TICKET-7',
      keepRuleEntriesReason: 'legal hold',
    });
    expect(JSON.stringify(a.details)).not.toContain(X);
    expect(JSON.stringify(a.details)).not.toContain(X_HANDLE);
  });

  it('fail wipes the identifiers and audits the failure', async () => {
    const { id } = await store.create(request(A));
    await store.claim(id);
    await store.fail(id, 'internal_error');
    expect(await row(id)).toMatchObject({
      status: 'failed',
      subjects_sealed: null,
      error_code: 'internal_error',
    });
    expect(await audits('privacy.request_failed')).toHaveLength(1);
    await store.fail(id, 'internal_error');
    expect(await audits('privacy.request_failed')).toHaveLength(1);
  });

  it('get and list are scoped to the organization and never carry subjects', async () => {
    const a1 = await store.create(request(A));
    const a2 = await store.create(request(A, { kind: 'export' }));
    const b = await store.create(request(B));
    expect(await store.get(B.organizationId, a1.id)).toBeNull();
    const got = await store.get(A.organizationId, a1.id);
    expect(got).toMatchObject({ id: a1.id, kind: 'erasure', status: 'queued', reference: 'TICKET-7' });
    expect(JSON.stringify(got)).not.toContain(X);
    expect(Object.keys(got!)).not.toContain('subjects');
    const list = await store.list(A.organizationId, { limit: 10 });
    expect(list.map((r) => r.id)).toEqual([a2.id, a1.id]);
    expect(list.map((r) => r.id)).not.toContain(b.id);
    expect(
      (await store.list(A.organizationId, { limit: 10, before: a2.id })).map((r) => r.id),
    ).toEqual([a1.id]);
    expect(await store.list(A.organizationId, { limit: 1 })).toHaveLength(1);
  });

  it('a sealed blob copied to another organization request does not open', async () => {
    const a = await store.create(request(A));
    const b = await store.create(request(B));
    const blob = (await row(a.id)).subjects_sealed as Buffer;
    await expect(
      open(keys, blob, { organizationId: B.organizationId, connectionId: b.id, kind: 'privacy_subject' }),
    ).rejects.toThrow();
    await expect(
      open(keys, blob, { organizationId: A.organizationId, connectionId: b.id, kind: 'privacy_subject' }),
    ).rejects.toThrow();
  });

  it('lists queued requests older than the cutoff', async () => {
    const old = await store.create(request(A));
    await store.create(request(A));
    await ctx.c.query(
      "UPDATE privacy_request SET created_at = now() - interval '10 minutes' WHERE id = $1",
      [old.id],
    );
    expect(await store.staleQueued(5 * 60_000)).toEqual([old.id]);
    await store.claim(old.id);
    expect(await store.staleQueued(5 * 60_000)).toEqual([]);
  });

  it('rejects an unknown organization without leaving a request behind', async () => {
    await expect(store.create(request(A, { organizationId: randomUUID() }))).rejects.toThrow();
    expect((await ctx.c.query('SELECT 1 FROM privacy_request')).rowCount).toBe(0);
  });
});
