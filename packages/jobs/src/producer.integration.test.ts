import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from '@feedbouncer/connectors';
import { createReferenceConnector, InMemoryPlatform } from '@feedbouncer/connectors/testing';
import { createPool } from '@feedbouncer/db';
import { createLogger } from '@feedbouncer/service-runtime';
import type pg from 'pg';
import { JobRegistry } from './definition.js';
import { bullJobId } from './keys.js';
import { PgJobLedger } from './ledger.js';
import { JobMetrics } from './metrics.js';
import { JobProducer } from './producer.js';
import { QueueSet, queueName } from './queues.js';
import { closeJobsDatabase, jobsDatabase, seedJobsTenant, type JobsTenant } from './testing/db.js';
import { testRedis, type TestRedis } from './testing/redis.js';

let pool: pg.Pool;
let producer: JobProducer;
let queues: QueueSet;
let redis: TestRedis;
let metrics: JobMetrics;
let ledger: PgJobLedger;
let jobsRegistry: JobRegistry;
let connectorsRegistry: ConnectorRegistry;
let t: JobsTenant;
let u: JobsTenant;
const scope = (x: JobsTenant) => ({
  organizationId: x.organizationId,
  brandId: x.brandId,
  connectionId: x.connectionId,
});

beforeAll(async () => {
  const db = await jobsDatabase();
  t = await seedJobsTenant(db, `p-${randomBytes(4).toString('hex')}`);
  u = await seedJobsTenant(db, `p-${randomBytes(4).toString('hex')}`);
  pool = createPool(db.db.url, { applicationName: 'jobs-producer-test', onIdleError: () => {} });
  redis = testRedis();
  const redirectUri = 'https://app.feedbouncer.test/oauth/callback';
  const connectors = new ConnectorRegistry();
  connectors.register(
    createReferenceConnector(
      new InMemoryPlatform({
        clock: { now: () => Date.now() },
        rotateRefreshTokens: true,
        accessTokenTtlMs: 3_600_000,
        webhookSecret: 'whsec-test-only',
        redirectUri,
      }),
      { flavor: 'push', redirectUri },
    ),
  );
  const jobs = new JobRegistry();
  jobs.register({
    type: 'echo',
    platforms: 'all',
    payload: z.strictObject({ ref: z.string(), body: z.string().optional() }),
    externalRef: (p) => p.ref,
    handle: async () => ({}),
  });
  jobsRegistry = jobs;
  connectorsRegistry = connectors;
  ledger = new PgJobLedger(pool);
  queues = new QueueSet({ connection: redis.connection, prefix: redis.prefix });
  metrics = new JobMetrics(createLogger('t', 'error', () => {}));
  producer = new JobProducer({
    ledger,
    jobs,
    connectors,
    queues,
    metrics,
    dedupWindowMs: 86_400_000,
  });
});
afterAll(async () => {
  await queues.close();
  await redis.cleanup();
  await pool.end();
  await closeJobsDatabase();
});

describe('JobProducer.enqueue', () => {
  it('enqueues once and reports the second enqueue as deduplicated', async () => {
    const req = {
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'c1:hide' },
    } as const;
    const a = await producer.enqueue(req);
    const b = await producer.enqueue(req);
    expect(a.status).toBe('enqueued');
    expect(b).toMatchObject({
      status: 'deduplicated',
      ledgerId: a.ledgerId,
      jobId: a.jobId,
      state: 'queued',
    });
    expect(await queues.queue('facebook').getJob(a.jobId)).toBeDefined();
    expect(metrics.count('deduplicated', 'facebook')).toBeGreaterThanOrEqual(1);
  });

  it('collapses concurrent enqueues to one job', async () => {
    const req = {
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'race-1' },
    } as const;
    const q = queues.queue('facebook');
    const jobIds = async () => new Set((await q.getJobs()).map((j) => j.id));
    const before = await jobIds();
    const results = await Promise.all(Array.from({ length: 10 }, () => producer.enqueue(req)));
    const added = [...(await jobIds())].filter((id) => !before.has(id));
    expect(added).toEqual([results[0]!.jobId]);
    expect(results.filter((r) => r.status === 'enqueued')).toHaveLength(1);
    expect(new Set(results.map((r) => r.ledgerId)).size).toBe(1);
    const n = await pool.query('SELECT count(*)::int AS n FROM job_ledger WHERE id = $1', [
      results[0]!.ledgerId,
    ]);
    expect(n.rows[0].n).toBe(1);
  });

  it('never collides across tenants for the same external id', async () => {
    const a = await producer.enqueue({
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'same-id' },
    });
    const b = await producer.enqueue({
      scope: scope(u),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'same-id' },
    });
    expect([a.status, b.status]).toEqual(['enqueued', 'enqueued']);
    expect(a.ledgerId).not.toBe(b.ledgerId);
  });

  it('stores only {v, ledgerId} in Redis', async () => {
    const r = await producer.enqueue({
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'priv', body: 'private comment text' },
    });
    const job = await queues.queue('facebook').getJob(r.jobId);
    expect(job?.data).toEqual({ v: 1, ledgerId: r.ledgerId });
    const raw = JSON.stringify(
      await redis.connection.hgetall(`${redis.prefix}:${queueName('facebook')}:${r.jobId}`),
    );
    expect(raw).not.toContain('private comment text');
  });

  it.each([
    [{ platform: 'youtube' }, 'unknown_platform'], // not registered in this registry
    [{ type: 'nope' }, 'unknown_job_type'],
    [{ payload: { ref: 'x', extra: 1 } }, 'invalid_payload'],
    [{ payload: { ref: 'has space' } }, 'invalid_idempotency_key'],
    [{ scope: { organizationId: 'x', brandId: 'y', connectionId: 'z' } }, 'invalid_scope'],
  ])('rejects %o with %s', async (over, code) => {
    await expect(
      producer.enqueue({
        scope: scope(t),
        platform: 'facebook',
        type: 'echo',
        payload: { ref: 'ok' },
        ...over,
      } as never),
    ).rejects.toMatchObject({ code });
  });

  it('refuses a scope mixing tenants (cross-tenant connection id)', async () => {
    await expect(
      producer.enqueue({
        scope: { ...scope(t), connectionId: u.connectionId },
        platform: 'facebook',
        type: 'echo',
        payload: { ref: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'connection_not_found' });
  });

  it('honours a caller-supplied key, tenant-scoped', async () => {
    const a = await producer.enqueue({
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'k1' },
      idempotencyKey: 'delivery-123',
    });
    const b = await producer.enqueue({
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'k2' },
      idempotencyKey: 'delivery-123',
    });
    const c = await producer.enqueue({
      scope: scope(u),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'k1' },
      idempotencyKey: 'delivery-123',
    });
    expect(b).toMatchObject({ status: 'deduplicated', ledgerId: a.ledgerId });
    expect(c.status).toBe('enqueued');
  });

  it('repairs a missing Redis job on a deduplicated enqueue', async () => {
    const req = {
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'repair' },
    } as const;
    const a = await producer.enqueue(req);
    await (await queues.queue('facebook').getJob(a.jobId))!.remove();
    await producer.enqueue(req);
    expect(await queues.queue('facebook').getJob(a.jobId)).toBeDefined();
  });
});

describe('JobProducer.replay', () => {
  it('concurrent replays run once and reuse the original job id', async () => {
    const r = await producer.enqueue({
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'dlq-1' },
    });
    await (await queues.queue('facebook').getJob(r.jobId))!.remove();
    await ledger.claim(r.ledgerId, 'w', 60_000);
    await ledger.deadLetter(r.ledgerId, 'w', {
      reason: 'retries_exhausted',
      resolution: null,
      errorKind: 'retryable',
      errorCode: 'timeout',
      countsAsFailure: true,
      retentionMs: 86_400_000,
    });
    const [a, b] = await Promise.all([
      producer.replay({ ids: [r.ledgerId], limit: 10 }),
      producer.replay({ ids: [r.ledgerId], limit: 10 }),
    ]);
    expect(a.length + b.length).toBe(1);
    const row = await ledger.get(r.ledgerId);
    expect((await queues.queue('facebook').getJob(r.jobId))?.id).toBe(
      bullJobId(row!.idempotencyKey),
    );
    expect(metrics.count('replayed', 'facebook')).toBe(1);
  });
});

describe('JobProducer.reconcile and ledger lifetime', () => {
  it('re-adds a stale queued job that is missing from Redis', async () => {
    const r = await producer.enqueue({
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'stale-1' },
    });
    await (await queues.queue('facebook').getJob(r.jobId))!.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await producer.reconcile(10, 100)).toBeGreaterThanOrEqual(1);
    expect(await queues.queue('facebook').getJob(r.jobId)).toBeDefined();
    expect(metrics.count('requeued', 'facebook')).toBeGreaterThanOrEqual(1);
  });

  it('expires the row one dedup window after enqueue', async () => {
    const r = await producer.enqueue({
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'ttl-1' },
    });
    const { rows } = await pool.query(
      'SELECT extract(epoch FROM expires_at - now()) AS s FROM job_ledger WHERE id = $1',
      [r.ledgerId],
    );
    expect(Number(rows[0].s)).toBeGreaterThan(86_400 - 60);
    expect(Number(rows[0].s)).toBeLessThanOrEqual(86_400);
  });

  it('keeps the row queued when the queue add fails, and a retry repairs it', async () => {
    const real = queues.add.bind(queues);
    let failures = 1;
    const flaky = Object.assign(Object.create(queues) as QueueSet, {
      add: async (...a: Parameters<QueueSet['add']>) => {
        if (failures-- > 0) throw new Error('queue unavailable');
        return real(...a);
      },
    });
    const p = new JobProducer({
      ledger,
      jobs: jobsRegistry,
      connectors: connectorsRegistry,
      queues: flaky,
      metrics,
      dedupWindowMs: 86_400_000,
    });
    const req = {
      scope: scope(t),
      platform: 'facebook',
      type: 'echo',
      payload: { ref: 'atomic-1', body: 'secret-body-text' },
    } as const;
    const err = await p.enqueue(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('secret-body-text');
    const rows = await pool.query(
      "SELECT id, state FROM job_ledger WHERE organization_id = $1 AND payload->>'ref' = 'atomic-1'",
      [t.organizationId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].state).toBe('queued');
    const again = await p.enqueue(req);
    expect(again).toMatchObject({ status: 'deduplicated', ledgerId: rows.rows[0].id });
    expect(await queues.queue('facebook').getJob(again.jobId)).toBeDefined();
  });
});
