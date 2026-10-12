import { randomBytes, randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Platform } from '@feedbouncer/connectors';
import {
  createMemoryStack,
  createReferenceConnector,
  InMemoryPlatform,
  platformDriver,
} from '@feedbouncer/connectors/testing';
import { policyResolver } from './config.js';
import { JobEnqueueError } from './errors.js';
import { requireActionSuccess } from './failure.js';
import type { JobLedgerPort } from './ledger.js';
import { JOB_ADD_OPTIONS, queueName } from './queues.js';
import { createJobProcessor, type BullJobLike } from './runner.js';
import { createJobsHarness, type JobsHarness } from './testing/index.js';

let h: JobsHarness;
const forgeQueues: Queue[] = [];
beforeEach(async () => {
  h = await createJobsHarness();
});
afterEach(async () => {
  await Promise.all(forgeQueues.splice(0).map((q) => q.close()));
  await h.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const enqueue = (ref: string, steps: string[], platform: 'facebook' | 'youtube' = 'facebook') =>
  h.producer.enqueue({
    scope: h.scope(0, platform),
    platform,
    type: 'scripted',
    payload: { ref, steps },
  });

/** Only the keys under this test's own unique prefix; never anything else on the shared instance. */
async function ownKeys(redis: Redis, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const batch of redis.scanStream({ match: `${prefix}:*`, count: 200 })) {
    keys.push(...(batch as string[]));
  }
  return keys;
}

/** "Redis restarted without persistence", scoped to this test's prefix. */
async function loseRedisState(): Promise<number> {
  const keys = await ownKeys(h.redis.connection, h.config.prefix);
  for (let i = 0; i < keys.length; i += 100)
    await h.redis.connection.del(...keys.slice(i, i + 100));
  return keys.length;
}

async function redisDump(): Promise<string> {
  const c = h.redis.connection;
  const out: unknown[] = [];
  for (const key of await ownKeys(c, h.config.prefix)) {
    const type = await c.type(key);
    let value: unknown = null;
    if (type === 'string') value = await c.get(key);
    else if (type === 'hash') value = await c.hgetall(key);
    else if (type === 'list') value = await c.lrange(key, 0, -1);
    else if (type === 'set') value = await c.smembers(key);
    else if (type === 'zset') value = await c.zrange(key, 0, -1, 'WITHSCORES');
    else if (type === 'stream') value = await c.xrange(key, '-', '+');
    out.push([key, type, value]);
  }
  return JSON.stringify(out);
}

async function ledgerDump(): Promise<string> {
  const { rows } = await h.pool.query<{ row: unknown }>(
    'SELECT to_jsonb(j) AS row FROM job_ledger j WHERE organization_id = ANY($1::uuid[])',
    [h.tenants.map((t) => t.organizationId)],
  );
  return JSON.stringify(rows);
}

/** Stands in for the lease running out: a crashed owner never renews it. */
async function expireLease(ledgerId: string): Promise<void> {
  await h.pool.query(
    `UPDATE job_ledger SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [ledgerId],
  );
}

async function leaseOwner(ledgerId: string): Promise<string | null> {
  const { rows } = await h.pool.query<{ lease_owner: string | null }>(
    'SELECT lease_owner FROM job_ledger WHERE id = $1',
    [ledgerId],
  );
  return rows[0]?.lease_owner ?? null;
}

function processorFor(platform: Platform, ledger: JobLedgerPort, workerId: string) {
  return createJobProcessor({
    platform,
    ledger,
    jobs: h.jobs,
    metrics: h.metrics,
    log: h.log,
    workerId,
    dlqRetentionMs: h.config.dlqRetentionMs,
    policyFor: policyResolver(h.config, h.jobs, platform),
  });
}

/**
 * A ledger whose claim works but whose every write after it never settles: the
 * process "dies" at the first outcome write. `atCrash` resolves when it gets there.
 */
function crashAfterClaim(real: JobLedgerPort): { ledger: JobLedgerPort; atCrash: Promise<void> } {
  let reached: () => void = () => {};
  const atCrash = new Promise<void>((r) => (reached = r));
  const never = (): Promise<boolean> => {
    reached();
    return new Promise<boolean>(() => {});
  };
  return {
    atCrash,
    ledger: {
      claim: (...a) => real.claim(...a),
      complete: never,
      recordRetry: never,
      recordDeferral: never,
      deadLetter: never,
    },
  };
}

/**
 * Fetches one job through a manual BullMQ worker (no processor, no lock
 * renewal), runs the real processor over a crashing ledger, and abandons the
 * job once it reaches its first outcome write.
 */
async function fetchAndAbandon(platform: Platform): Promise<void> {
  const manual = new Worker(queueName(platform), null, {
    connection: h.redis.connection,
    prefix: h.config.prefix,
    lockDuration: 1_000,
  });
  try {
    const token = randomUUID();
    const job = await manual.getNextJob(token, { block: false });
    if (!job) throw new Error('no job fetched');
    const c = crashAfterClaim(h.ledger);
    void processorFor(platform, c.ledger, 'crashing-worker')(job, token).catch(() => undefined);
    await c.atCrash;
  } finally {
    await manual.close();
  }
}

/** A queued row with no Redis job: only a forged job can ever deliver it. */
async function insertRow(platform: 'facebook' | 'youtube', jobType: string, payload: object) {
  const res = await h.ledger.insert({
    scope: h.scope(0, platform),
    platform,
    jobType,
    idempotencyKey: randomBytes(32).toString('hex'),
    payloadJson: JSON.stringify(payload),
    ttlMs: h.config.dedupWindowMs,
  });
  if (res.status !== 'inserted') throw new Error('row not inserted');
  return res.id;
}

function forgeQueue(platform: Platform): Queue {
  const q = new Queue(queueName(platform), {
    connection: h.redis.connection,
    prefix: h.config.prefix,
  });
  q.on('error', () => {});
  forgeQueues.push(q);
  return q;
}

const logged = (msg: string) =>
  h.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === msg);

async function queueIsEmpty(q: Queue): Promise<boolean> {
  const counts = await q.getJobCounts('wait', 'active', 'delayed', 'failed', 'prioritized');
  return Object.values(counts).every((n) => n === 0);
}

describe('crashes between the effect and the ack', () => {
  it('a crash after completion is recorded does not repeat the side effect', async () => {
    const r = await enqueue('crash-after-complete', ['ok']);
    const manual = new Worker(queueName('facebook'), null, {
      connection: h.redis.connection,
      prefix: h.config.prefix,
      lockDuration: 1_000,
    });
    try {
      const token = randomUUID();
      const job = await manual.getNextJob(token, { block: false });
      if (!job) throw new Error('no job fetched');
      expect(await processorFor('facebook', h.ledger, 'crashing-worker')(job, token)).toBe(
        'processed',
      );
      // no moveToCompleted: the process dies before the ack
    } finally {
      await manual.close();
    }
    expect(h.script.sideEffects.get('crash-after-complete')).toBe(1);
    expect((await h.ledger.get(r.ledgerId))?.state).toBe('completed');

    await h.workers(); // the stalled checker returns the job to wait; the redelivery is acked
    await expect
      .poll(() => h.metrics.count('duplicate_delivery', 'facebook'), { timeout: 10_000 })
      .toBe(1);
    expect(h.script.sideEffects.get('crash-after-complete')).toBe(1);
    expect(h.script.runs.get('crash-after-complete')).toHaveLength(1);
  });

  it('a crash after the effect but before the completion is recorded runs the handler again', async () => {
    // At-least-once: the ledger cannot know the effect happened, so the
    // takeover re-runs the handler. Handlers must be idempotent (see the
    // definition docs); this pins the behaviour so a change is a conscious one.
    const r = await enqueue('crash-before-complete', ['ok']);
    await fetchAndAbandon('facebook');
    expect(h.script.sideEffects.get('crash-before-complete')).toBe(1);
    expect((await h.ledger.get(r.ledgerId))?.state).toBe('queued');
    expect(await leaseOwner(r.ledgerId)).not.toBeNull();

    await expireLease(r.ledgerId);
    await h.workers();
    const row = await h.waitFor(r.ledgerId, ['completed'], 15_000);
    expect(row.crashes).toBe(1);
    expect(h.script.runs.get('crash-before-complete')).toHaveLength(2);
    expect(h.script.sideEffects.get('crash-before-complete')).toBe(2);
  });

  it('a poison job that keeps crashing workers is bounded, dead-lettered, and blocks nothing', async () => {
    const poison = await enqueue('poison', ['ok']);
    const forged: BullJobLike = {
      id: 'poison',
      name: 'scripted',
      data: { v: 1, ledgerId: poison.ledgerId },
      moveToDelayed: async () => {},
    };
    // Three workers take the job, run the handler and die before recording an outcome.
    for (let i = 0; i < 3; i++) {
      const c = crashAfterClaim(h.ledger);
      void processorFor('facebook', c.ledger, `dead-${i}`)(forged).catch(() => undefined);
      await c.atCrash;
      await expireLease(poison.ledgerId);
    }
    expect(h.script.runs.get('poison')).toHaveLength(3);
    expect((await h.ledger.get(poison.ledgerId))?.crashes).toBe(2);

    const next = await enqueue('next', ['ok']);
    await h.workers(); // fourth claim: failures + crashes = 3 >= maxAttempts
    const row = await h.waitFor(poison.ledgerId, ['dead_lettered'], 15_000);
    expect(row).toMatchObject({
      deadLetterReason: 'stall_limit_exceeded',
      lastErrorKind: 'stalled',
      lastErrorCode: 'worker_crashed',
      crashes: 3,
    });
    await h.waitFor(next.ledgerId, ['completed']);
    expect(h.script.runs.get('poison')).toHaveLength(3); // the handler did not run a fourth time
  });
});

describe('Redis losing its state', () => {
  it('re-adds every waiting job and runs each exactly once', async () => {
    const a = await enqueue('lost-a', ['ok']);
    const b = await enqueue('lost-b', ['transient', 'ok']);
    const c = await enqueue('lost-c', ['ok'], 'youtube');
    expect(await loseRedisState()).toBeGreaterThan(0);

    await h.workers(); // the sweeper (200 ms, stale after 500 ms) puts them back
    for (const r of [a, b, c]) await h.waitFor(r.ledgerId, ['completed'], 15_000);
    await sleep(1_500); // several sweeps: nothing may run twice
    expect(h.script.sideEffects.get('lost-a')).toBe(1);
    expect(h.script.sideEffects.get('lost-b')).toBe(1);
    expect(h.script.sideEffects.get('lost-c')).toBe(1);
    expect(h.script.runs.get('lost-a')).toHaveLength(1);
    expect(h.script.runs.get('lost-b')).toHaveLength(2);
    expect(h.script.runs.get('lost-c')).toHaveLength(1);
    expect(h.metrics.count('requeued', 'facebook')).toBeGreaterThanOrEqual(2);
    expect(h.metrics.count('requeued', 'youtube')).toBeGreaterThanOrEqual(1);
  });

  it('re-adds delayed retries too, while the workers keep running', async () => {
    await h.workers();
    // Delayed in Redis for ~1.5 s, with the due time in the ledger.
    const delayed = await enqueue('lost-delayed', ['rate:1500', 'ok']);
    await expect.poll(() => h.metrics.count('deferred', 'facebook')).toBe(1);
    expect(await loseRedisState()).toBeGreaterThan(0);
    const fresh = await enqueue('after-loss', ['ok']); // new work still flows

    await h.waitFor(fresh.ledgerId, ['completed']);
    // The ledger knows it is due; the sweeper restores it shortly after.
    await h.waitFor(delayed.ledgerId, ['completed'], 15_000);
    await sleep(1_000);
    expect(h.script.runs.get('lost-delayed')).toHaveLength(2);
    expect(h.script.sideEffects.get('lost-delayed')).toBe(1);
    expect(h.metrics.count('requeued', 'facebook')).toBeGreaterThanOrEqual(1);
  });
});

describe('forged and stale queue entries', () => {
  it('drops junk job data without running anything or retrying', async () => {
    const id = await insertRow('facebook', 'scripted', { ref: 'junk-target', steps: ['ok'] });
    await h.workers({ config: { ...h.config, staleAfterMs: 60_000 } });
    const q = forgeQueue('facebook');
    const bad: unknown[] = [
      {},
      'a string',
      null,
      { v: 1, ledgerId: 'not-a-uuid' },
      { v: 2, ledgerId: id },
      { v: 1, ledgerId: id, extra: 'field' },
    ];
    for (const data of bad) await q.add('scripted', data, { ...JOB_ADD_OPTIONS });
    await q.add('no_such_type', { v: 1, ledgerId: id }, { ...JOB_ADD_OPTIONS });

    await expect.poll(() => logged('job.invalid_data').length, { timeout: 10_000 }).toBe(7);
    await sleep(1_000);
    expect(logged('job.invalid_data')).toHaveLength(7); // no retry loop
    expect(await queueIsEmpty(q)).toBe(true);
    expect(h.script.runs.size).toBe(0);
    // The real row was never touched by a junk delivery.
    expect(await h.ledger.get(id)).toMatchObject({ state: 'queued', crashes: 0, failures: 0 });
    expect(await leaseOwner(id)).toBeNull();
  });

  it('never runs a handler for a ledger row that belongs to another platform queue', async () => {
    const id = await insertRow('facebook', 'scripted', { ref: 'wrong-queue', steps: ['ok'] });
    await h.workers({ config: { ...h.config, staleAfterMs: 60_000 } });
    const q = forgeQueue('youtube');
    await q.add('scripted', { v: 1, ledgerId: id }, { ...JOB_ADD_OPTIONS });

    const row = await h.waitFor(id, ['dead_lettered']);
    expect(row).toMatchObject({ deadLetterReason: 'invalid_job', lastErrorCode: 'queue_mismatch' });
    await sleep(500);
    expect(h.script.runs.get('wrong-queue')).toBeUndefined();
    expect(await queueIsEmpty(q)).toBe(true);
  });

  it('never runs a handler for a ledger row of another job type', async () => {
    let otherRuns = 0;
    h.jobs.register({
      type: 'other_type',
      platforms: 'all',
      payload: z.strictObject({ ref: z.string() }),
      externalRef: (p) => p.ref,
      handle: async () => {
        otherRuns += 1;
        return { status: 'ok' };
      },
    });
    const scriptedRow = await insertRow('facebook', 'scripted', { ref: 'typed', steps: ['ok'] });
    const otherRow = await insertRow('facebook', 'other_type', { ref: 'typed-other' });
    await h.workers({ config: { ...h.config, staleAfterMs: 60_000 } });
    const q = forgeQueue('facebook');
    await q.add('other_type', { v: 1, ledgerId: scriptedRow }, { ...JOB_ADD_OPTIONS });
    await q.add('scripted', { v: 1, ledgerId: otherRow }, { ...JOB_ADD_OPTIONS });

    for (const id of [scriptedRow, otherRow]) {
      expect(await h.waitFor(id, ['dead_lettered'])).toMatchObject({
        deadLetterReason: 'invalid_job',
        lastErrorCode: 'queue_mismatch',
      });
    }
    expect(otherRuns).toBe(0);
    expect(h.script.runs.size).toBe(0);
    expect(await queueIsEmpty(q)).toBe(true);
  });

  it('acks a job whose ledger row was purged, without retrying', async () => {
    const id = await insertRow('facebook', 'scripted', { ref: 'purged', steps: ['ok'] });
    await h.pool.query('DELETE FROM job_ledger WHERE id = $1', [id]);
    await h.workers({ config: { ...h.config, staleAfterMs: 60_000 } });
    const q = forgeQueue('facebook');
    await q.add('scripted', { v: 1, ledgerId: id }, { ...JOB_ADD_OPTIONS });
    await q.add('scripted', { v: 1, ledgerId: randomUUID() }, { ...JOB_ADD_OPTIONS });

    await expect.poll(() => logged('job.missing').length, { timeout: 10_000 }).toBe(2);
    await sleep(1_000);
    expect(logged('job.missing')).toHaveLength(2);
    expect(await queueIsEmpty(q)).toBe(true);
    expect(h.script.runs.size).toBe(0);
  });
});

describe('shutdown', () => {
  it('finishes in-flight jobs on close, and delayed retries survive a restart', async () => {
    const w1 = await h.workers();
    const inflight = await enqueue('slow', ['hang']);
    const later = await enqueue('later', ['rate:1500', 'ok']);
    await expect.poll(() => h.script.runs.get('slow')?.length ?? 0).toBe(1);
    await expect.poll(async () => (await h.ledger.get(later.ledgerId))?.deferrals ?? 0).toBe(1);

    setTimeout(() => h.script.release('slow'), 300);
    await w1.close(); // waits for 'slow'
    expect((await h.ledger.get(inflight.ledgerId))?.state).toBe('completed');
    expect((await h.ledger.get(later.ledgerId))?.state).toBe('queued');

    await h.workers(); // restart
    const row = await h.waitFor(later.ledgerId, ['completed'], 15_000);
    expect(row.deferrals).toBe(1);
    expect(h.script.runs.get('slow')).toHaveLength(1);
    expect(h.script.runs.get('later')).toHaveLength(2);
    expect(h.script.sideEffects.get('later')).toBe(1);
    expect(logged('job.duplicate_delivery')).toHaveLength(0);
  });
});

describe('expired credentials', () => {
  it('makes one refresh attempt, then needs_reconnection with no retries', async () => {
    const redirectUri = 'https://app.feedbouncer.test/oauth/callback';
    const platform = new InMemoryPlatform({
      clock: { now: () => Date.now() },
      rotateRefreshTokens: false,
      accessTokenTtlMs: 3_600_000,
      webhookSecret: null,
      redirectUri,
    });
    const connector = createReferenceConnector(platform, { flavor: 'poll', redirectUri });
    const stack = await createMemoryStack(connector, { webhookSecret: null, redirectUri });
    const driver = platformDriver(platform);
    const account = await driver.createAccount();
    const { authorizationUrl } = await stack.oauth.start(stack.actor, connector.platform);
    const done = await stack.oauth.complete(
      stack.actor,
      connector.platform,
      await driver.consent(authorizationUrl, account),
    );
    if (!done.ok) throw new Error('connect failed');
    const source = await driver.seedSource(account);
    const [comment] = await driver.seedComments(account, source, 1);
    const stackScope = {
      organizationId: stack.actor.organizationId,
      brandId: stack.actor.brandId,
      connectionId: done.connectionId,
    };

    let handlerRuns = 0;
    h.jobs.register({
      type: 'hide_comment',
      platforms: ['youtube'],
      payload: z.strictObject({ sourceId: z.string(), commentId: z.string() }),
      externalRef: (p) => `${p.commentId}:hide`,
      // Test-only mapping: the ledger row's scope is the Postgres tenant; the connector stack is in memory.
      handle: async (_ctx, p) => {
        handlerRuns += 1;
        return requireActionSuccess(
          await (
            await stack.runtime.connect(stackScope)
          ).act({
            action: 'hide',
            target: { sourceExternalId: p.sourceId, externalId: p.commentId },
          }),
        );
      },
    });
    await driver.revokeGrant(account);
    await driver.expireAccessTokens();
    const refreshesBefore = await driver.calls('refresh');
    await h.workers();
    const r = await h.producer.enqueue({
      scope: h.scope(0, 'youtube'),
      platform: 'youtube',
      type: 'hide_comment',
      payload: { sourceId: source, commentId: comment! },
    });
    const row = await h.waitFor(r.ledgerId, ['dead_lettered']);
    expect(row.deadLetterReason).toBe('needs_reconnection');
    await sleep(1_000); // a retry would show up as a second run
    expect(handlerRuns).toBe(1);
    expect((await driver.calls('refresh')) - refreshesBefore).toBe(1);
    expect(await h.ledger.get(r.ledgerId)).toMatchObject({ failures: 1, crashes: 0, deferrals: 0 });

    // None of the tokens the platform issued reached a log line, the ledger or Redis.
    const secrets = platform.issuedSecrets();
    expect(secrets.length).toBeGreaterThan(0);
    const everything = [
      h.lines.join('\n'),
      stack.lines.join('\n'),
      await ledgerDump(),
      await redisDump(),
    ].join('\n');
    for (const s of secrets) expect(everything).not.toContain(s);
  });
});

describe('secret hygiene', () => {
  const SECRET = 'SHOULD_NOT_LEAK';

  it('keeps handler error text out of logs, the ledger and Redis', async () => {
    h.jobs.register({
      type: 'leaky',
      platforms: 'all',
      payload: z.strictObject({ ref: z.string() }),
      externalRef: (p) => p.ref,
      handle: async () => {
        class LeakyError extends Error {
          override name = 'LeakyError';
        }
        throw new LeakyError(`GET https://api.example.test/x?access_token=${SECRET} failed`, {
          cause: new Error(`refresh_token=${SECRET}`),
        });
      },
    });
    await h.workers();
    const dead = await enqueue('leaky-scripted', ['throw']);
    const leaky = await h.producer.enqueue({
      scope: h.scope(0, 'facebook'),
      platform: 'facebook',
      type: 'leaky',
      payload: { ref: 'leaky-typed' },
    });
    const delayed = await enqueue('leaky-delayed', ['rate:5000', 'ok']);
    await h.waitFor(dead.ledgerId, ['dead_lettered']);
    await h.waitFor(leaky.ledgerId, ['dead_lettered']);
    await expect.poll(() => h.metrics.count('deferred', 'facebook')).toBe(1);

    const listed = JSON.stringify(
      await h.ledger.listDeadLetters({ ids: [dead.ledgerId, leaky.ledgerId], limit: 10 }),
    );
    expect(listed).toContain(dead.ledgerId); // the dump is not vacuous
    expect(listed).not.toContain(SECRET);
    expect(await ledgerDump()).not.toContain(SECRET);
    expect(h.lines.join('\n')).not.toContain(SECRET);
    const redis = await redisDump();
    expect(redis).toContain(delayed.jobId); // the delayed job's hash is part of what was scanned
    expect(redis).not.toContain(SECRET);
  });

  it('refuses a secret-bearing payload without echoing it or storing anything', async () => {
    h.jobs.register({
      type: 'loose',
      platforms: 'all',
      payload: z.strictObject({ ref: z.string(), meta: z.record(z.string(), z.string()) }),
      externalRef: (p) => p.ref,
      handle: async () => ({ status: 'ok' }),
    });
    const err = await h.producer
      .enqueue({
        scope: h.scope(0, 'facebook'),
        platform: 'facebook',
        type: 'loose',
        payload: { ref: 'with-secret', meta: { access_token: SECRET } },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobEnqueueError);
    expect((err as JobEnqueueError).code).toBe('payload_contains_secret');
    expect(String(err)).not.toContain(SECRET);
    expect(await ledgerDump()).not.toContain(SECRET);
    expect(await redisDump()).not.toContain(SECRET);
    expect(h.lines.join('\n')).not.toContain(SECRET);
    const { rowCount } = await h.pool.query(`SELECT 1 FROM job_ledger WHERE job_type = 'loose'`);
    expect(rowCount).toBe(0);
  });
});
