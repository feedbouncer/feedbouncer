import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import type pg from 'pg';
import { PgJobLedger } from './ledger.js';
import { closeJobsDatabase, jobsDatabase, seedJobsTenant, type JobsTenant } from './testing/db.js';

let pool: pg.Pool;
let ledger: PgJobLedger;
let t: JobsTenant;
let u: JobsTenant;
const key = () => randomBytes(32).toString('hex');
const scopeOf = (x: JobsTenant) => ({
  organizationId: x.organizationId,
  brandId: x.brandId,
  connectionId: x.connectionId,
});
async function add(k = key(), x = t): Promise<string> {
  const r = await ledger.insert({
    scope: scopeOf(x),
    platform: 'facebook',
    jobType: 'scripted',
    idempotencyKey: k,
    payloadJson: '{"ref":"r"}',
    ttlMs: 86_400_000,
    traceContext: null,
  });
  if (r.status !== 'inserted') throw new Error(`expected insert, got ${r.status}`);
  return r.id;
}
async function claimed(id: string, owner = 'w1') {
  const c = await ledger.claim(id, owner, 60_000);
  if (c.status !== 'claimed') throw new Error(`expected claim, got ${c.status}`);
  return c.row;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const db = await jobsDatabase();
  t = await seedJobsTenant(db, `l-${randomBytes(4).toString('hex')}`);
  u = await seedJobsTenant(db, `l-${randomBytes(4).toString('hex')}`);
  pool = createPool(db.db.url, { applicationName: 'jobs-ledger-test', onIdleError: () => {} });
  ledger = new PgJobLedger(pool);
});
afterAll(async () => {
  await pool.end();
  await closeJobsDatabase();
});

describe('PgJobLedger.insert', () => {
  it('inserts once per (organization, key) and reports the existing row after', async () => {
    const k = key();
    const id = await add(k);
    const again = await ledger.insert({
      scope: scopeOf(t),
      platform: 'facebook',
      jobType: 'scripted',
      idempotencyKey: k,
      payloadJson: '{}',
      ttlMs: 1_000,
      traceContext: null,
    });
    expect(again).toEqual({ status: 'exists', id, state: 'queued' });
  });
  it('refuses a scope whose connection is in another organization or on another platform', async () => {
    const cross = await ledger.insert({
      scope: { ...scopeOf(t), connectionId: u.connectionId },
      platform: 'facebook',
      jobType: 'scripted',
      idempotencyKey: key(),
      payloadJson: '{}',
      ttlMs: 1_000,
      traceContext: null,
    });
    expect(cross).toEqual({ status: 'no_connection' });
    const wrongPlatform = await ledger.insert({
      scope: scopeOf(t),
      platform: 'youtube',
      jobType: 'scripted',
      idempotencyKey: key(),
      payloadJson: '{}',
      ttlMs: 1_000,
      traceContext: null,
    });
    expect(wrongPlatform).toEqual({ status: 'no_connection' });
  });
});

describe('claim / complete', () => {
  it('claims, completes with a result, then reports settled to every redelivery', async () => {
    const id = await add();
    await claimed(id);
    expect(await ledger.complete(id, 'w1', '{"status":"applied"}')).toBe(true);
    expect(await ledger.claim(id, 'w2', 60_000)).toEqual({ status: 'settled', state: 'completed' });
    expect((await ledger.get(id))?.result).toEqual({ status: 'applied' });
  });
  it('reports busy while another worker holds the lease, and counts a crash on takeover', async () => {
    const id = await add();
    await ledger.claim(id, 'w1', 200);
    expect((await ledger.claim(id, 'w2', 60_000)).status).toBe('busy');
    await sleep(300);
    expect((await claimed(id, 'w2')).crashes).toBe(1);
    expect(await ledger.complete(id, 'w1', '{}')).toBe(false); // stale owner cannot complete
  });
  it('reports missing for unknown ids', async () => {
    expect(await ledger.claim('00000000-0000-4000-8000-000000000000', 'w', 1_000)).toEqual({
      status: 'missing',
    });
  });
  it('defers a claim before next_run_at (crash between recordRetry and moveToDelayed)', async () => {
    const id = await add();
    await claimed(id);
    await ledger.recordRetry(id, 'w1', { kind: 'retryable', code: 'upstream_5xx' }, 5_000);
    const c = await ledger.claim(id, 'w1', 60_000);
    expect(c.status).toBe('busy');
    expect(c.status === 'busy' ? c.retryInMs : 0).toBeGreaterThan(3_000);
  });
});

describe('failure bookkeeping and DLQ', () => {
  it('records retries and deferrals separately', async () => {
    const id = await add();
    await claimed(id);
    await ledger.recordDeferral(id, 'w1', 'throttled', 0);
    await claimed(id);
    await ledger.recordRetry(id, 'w1', { kind: 'retryable', code: 'timeout' }, 0);
    expect(await ledger.get(id)).toMatchObject({
      failures: 1,
      deferrals: 1,
      deferredMs: 0,
      crashes: 0,
      lastErrorCode: 'timeout',
    });
  });
  it('dead-letters with metadata, extends expiry to retention, lists by org, and replays once', async () => {
    const id = await add();
    await claimed(id);
    await ledger.deadLetter(id, 'w1', {
      reason: 'non_retryable',
      resolution: null,
      errorKind: 'non_retryable',
      errorCode: 'invalid_request',
      countsAsFailure: true,
      retentionMs: 14 * 86_400_000,
    });
    const [entry] = await ledger.listDeadLetters({
      organizationId: t.organizationId,
      ids: [id],
      limit: 10,
    });
    expect(entry).toMatchObject({
      reason: 'non_retryable',
      lastErrorCode: 'invalid_request',
      failures: 1,
      jobType: 'scripted',
      platform: 'facebook',
    });
    expect(
      await ledger.listDeadLetters({ organizationId: u.organizationId, ids: [id], limit: 10 }),
    ).toEqual([]);
    const exp = (await pool.query('SELECT expires_at FROM job_ledger WHERE id = $1', [id])).rows[0]
      .expires_at as Date;
    expect(exp.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const [a, b] = await Promise.all([
      ledger.replay({ ids: [id], limit: 10 }, 30 * 86_400_000),
      ledger.replay({ ids: [id], limit: 10 }, 30 * 86_400_000),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(await ledger.get(id)).toMatchObject({
      state: 'queued',
      replays: 1,
      failures: 0,
      deadLetterReason: null,
    });
  });
  it('resolves instead of dead-lettering when resolution is given, and resolved rows are not replayable', async () => {
    const id = await add();
    await claimed(id);
    await ledger.deadLetter(id, 'w1', {
      reason: 'non_retryable',
      resolution: 'target_gone',
      errorKind: 'non_retryable',
      errorCode: 'target_not_found',
      countsAsFailure: true,
      retentionMs: 1_000,
    });
    expect(await ledger.get(id)).toMatchObject({ state: 'resolved', resolution: 'target_gone' });
    expect(await ledger.replay({ ids: [id], limit: 10 }, 1_000)).toEqual([]);
  });
  it('lists oldest-first on request, in the order replay takes rows', async () => {
    const ids = [await add(), await add(), await add()];
    for (const id of ids) {
      await claimed(id);
      await ledger.deadLetter(id, 'w1', {
        reason: 'non_retryable',
        resolution: null,
        errorKind: 'non_retryable',
        errorCode: 'invalid_request',
        countsAsFailure: true,
        retentionMs: 1_000,
      });
      await sleep(5);
    }
    const filter = { organizationId: t.organizationId, ids, limit: 2 };
    const oldest = await ledger.listDeadLetters(filter, 'oldest');
    expect(oldest.map((r) => r.id)).toEqual(ids.slice(0, 2));
    const newest = await ledger.listDeadLetters(filter);
    expect(newest.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    const replayed = await ledger.replay(filter, 1_000);
    expect(replayed.map((r) => r.id).sort()).toEqual(ids.slice(0, 2).sort());
  });
  it('rejects invalid filter values without echoing them', async () => {
    await expect(
      ledger.listDeadLetters({ organizationId: "x' OR 1=1 --", limit: 10 }),
    ).rejects.toThrow('invalid filter: organizationId');
    await expect(
      ledger.listDeadLetters({ organizationId: "x' OR 1=1 --", limit: 10 }),
    ).rejects.not.toThrow('OR 1=1');
  });
});

describe('sweeper queries', () => {
  it('returns stale queued rows once per stale window and never purges queued rows', async () => {
    const id = await add();
    await pool.query("UPDATE job_ledger SET expires_at = now() - interval '1 day' WHERE id = $1", [
      id,
    ]);
    await sleep(50);
    expect((await ledger.staleQueued(10, 1_000)).map((s) => s.id)).toContain(id);
    expect((await ledger.staleQueued(10_000, 1_000)).map((s) => s.id)).not.toContain(id); // touched
    await ledger.purgeExpired(1_000);
    expect(await ledger.get(id)).not.toBeNull();
  });
  it('purges expired settled rows', async () => {
    const id = await add();
    await claimed(id);
    await ledger.complete(id, 'w1', '{}');
    await pool.query(
      "UPDATE job_ledger SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    expect(await ledger.purgeExpired(1_000)).toBeGreaterThanOrEqual(1);
    expect(await ledger.get(id)).toBeNull();
  });
  it('never purges a row a concurrent replay has just re-queued', async () => {
    const id = await add();
    await claimed(id);
    await ledger.deadLetter(id, 'w1', {
      reason: 'non_retryable',
      resolution: null,
      errorKind: 'non_retryable',
      errorCode: 'invalid_request',
      countsAsFailure: true,
      retentionMs: 1_000,
    });
    await pool.query(
      "UPDATE job_ledger SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    // Stand in for a replay that has not committed yet: hold the row lock.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE job_ledger SET state = 'queued', dead_letter_reason = NULL, dead_lettered_at = NULL,
           resolution = NULL, expires_at = now() + interval '1 day' WHERE id = $1`,
        [id],
      );
      const purge = ledger.purgeExpired(1_000);
      await sleep(300);
      await c.query('COMMIT');
      await purge;
    } finally {
      c.release();
    }
    expect(await ledger.get(id)).toMatchObject({ state: 'queued' });
  });
  it('returns a queued row with a past next_run_at once per stale window', async () => {
    const id = await add();
    await claimed(id);
    await ledger.recordRetry(id, 'w1', { kind: 'retryable', code: 'timeout' }, 0);
    await pool.query(
      "UPDATE job_ledger SET next_run_at = now() - interval '1 hour' WHERE id = $1",
      [id],
    );
    await sleep(50);
    expect((await ledger.staleQueued(10, 1_000)).map((s) => s.id)).toContain(id);
    expect((await ledger.staleQueued(10_000, 1_000)).map((s) => s.id)).not.toContain(id);
  });
});

describe('numeric inputs', () => {
  it('rounds fractional delays up and rejects non-finite or negative values', async () => {
    const id = await add();
    await claimed(id);
    expect(await ledger.recordDeferral(id, 'w1', 'throttled', 1500.5)).toBe(true);
    expect((await ledger.get(id))?.deferredMs).toBe(1501);
    await sleep(1_100);
    await claimed(id);
    expect(await ledger.recordRetry(id, 'w1', { kind: 'retryable', code: 'timeout' }, 10.2)).toBe(
      true,
    );
    await expect(ledger.claim(id, 'w', Number.NaN)).rejects.toThrow(RangeError);
    await expect(
      ledger.recordRetry(id, 'w1', { kind: 'retryable', code: 'x' }, -1),
    ).rejects.toThrow(RangeError);
    await expect(ledger.staleQueued(Number.POSITIVE_INFINITY, 10)).rejects.toThrow(RangeError);
  });
});

describe('trace context, wait time and queue stats', () => {
  const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  const insertWith = async (traceContext: string | null) => {
    const r = await ledger.insert({
      scope: scopeOf(t),
      platform: 'facebook',
      jobType: 'scripted',
      idempotencyKey: key(),
      payloadJson: '{"ref":"r"}',
      ttlMs: 86_400_000,
      traceContext,
    });
    if (r.status !== 'inserted') throw new Error('expected insert');
    return r.id;
  };

  it('stores a valid traceparent, drops a malformed one, and the first writer wins', async () => {
    const good = await insertWith(TP);
    expect((await claimed(good)).traceContext).toBe(TP);
    const bad = await insertWith('00-nothex-bad-01');
    expect((await claimed(bad)).traceContext).toBeNull();
    const k = key();
    const input = {
      scope: scopeOf(t),
      platform: 'facebook' as const,
      jobType: 'scripted',
      idempotencyKey: k,
      payloadJson: '{"ref":"r"}',
      ttlMs: 86_400_000,
    };
    await ledger.insert({ ...input, traceContext: TP });
    const again = await ledger.insert({
      ...input,
      traceContext: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    expect(again.status).toBe('exists');
    const { rows } = await pool.query<{ trace_context: string }>(
      'SELECT trace_context FROM job_ledger WHERE idempotency_key = $1',
      [k],
    );
    expect(rows[0]!.trace_context).toBe(TP);
  });

  it('reports wait from creation on first run and from next_run_at on retries', async () => {
    const id = await insertWith(null);
    await sleep(50);
    const first = await ledger.claim(id, 'w1', 60_000);
    if (first.status !== 'claimed') throw new Error('expected claim');
    expect(first.waitMs).toBeGreaterThanOrEqual(40);
    expect(await ledger.recordRetry(id, 'w1', { kind: 'retryable', code: 'x' }, 100)).toBe(true);
    await sleep(1_300);
    const second = await ledger.claim(id, 'w2', 60_000);
    if (second.status !== 'claimed') throw new Error('expected claim');
    expect(second.waitMs).not.toBeNull();
    expect(second.waitMs!).toBeGreaterThanOrEqual(0);
    expect(second.waitMs!).toBeLessThan(5_000);
  });

  it('queueStats counts queued rows per platform', async () => {
    const id = await insertWith(null);
    const stats = await ledger.queueStats();
    const fb = stats.find((s) => s.platform === 'facebook')!;
    expect(fb.depth).toBeGreaterThanOrEqual(1);
    expect(fb.oldestAgeMs).toBeGreaterThanOrEqual(0);
    await claimed(id);
    await ledger.complete(id, 'w1', '{}');
  });
});
