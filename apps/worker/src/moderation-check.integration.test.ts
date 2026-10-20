import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, ZERO_SCORES, type ClassifierProvider } from '@feedbouncer/classifier';
import { createPool } from '@feedbouncer/db';
import { migratedDb } from '@feedbouncer/db/testing';
import { testRedis, type TestRedis } from '@feedbouncer/jobs/testing';
import {
  MODERATION_CHECK_QUEUE,
  type CheckDeps,
  type CheckJobData,
  type CheckJobResult,
} from '@feedbouncer/moderation-check';
import { DisabledPolicyEvaluator } from '@feedbouncer/policies';
import { compileRuleSet } from '@feedbouncer/rules';
import type { Logger } from '@feedbouncer/service-runtime';
import { startModerationCheckWorker } from './moderation-check.js';

const MARKER = 'zq-secret-marker';
const TABLES = [
  'comment',
  'rule_evaluation',
  'comment_classification',
  'policy_evaluation',
  'moderation_action',
  'decision',
  'job_ledger',
] as const;

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
let redis: TestRedis;
let queue: Queue;
let events: QueueEvents;
let orgId: string;
let brandId: string;
let archivedBrandId: string;
let otherOrgBrandId: string;

const counts = async () =>
  Object.fromEntries(
    await Promise.all(
      TABLES.map(
        async (t) =>
          [
            t,
            (await h.c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n,
          ] as const,
      ),
    ),
  );

async function org(label: string, archived = false) {
  const o = (
    await h.c.query<{ id: string }>('INSERT INTO organization (name) VALUES ($1) RETURNING id', [
      label,
    ])
  ).rows[0]!.id;
  const b = (
    await h.c.query<{ id: string }>(
      `INSERT INTO brand (organization_id, name, archived_at)
       VALUES ($1, 'Brand', ${archived ? 'now()' : 'NULL'}) RETURNING id`,
      [o],
    )
  ).rows[0]!.id;
  return { o, b };
}

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'moderation-check-test', onIdleError: () => {} });
  redis = testRedis();
  queue = new Queue(MODERATION_CHECK_QUEUE, { connection: redis.connection, prefix: redis.prefix });
  events = new QueueEvents(MODERATION_CHECK_QUEUE, {
    connection: redis.connection.duplicate(),
    prefix: redis.prefix,
  });
  await events.waitUntilReady();
  ({ o: orgId, b: brandId } = await org('A'));
  archivedBrandId = (
    await h.c.query<{ id: string }>(
      "INSERT INTO brand (organization_id, name, archived_at) VALUES ($1, 'Old', now()) RETURNING id",
      [orgId],
    )
  ).rows[0]!.id;
  otherOrgBrandId = (await org('B')).b;
});
afterAll(async () => {
  await events.close();
  await queue.close();
  await redis.cleanup();
  await pool.end();
  await h.close();
});

class FakeClassifier implements ClassifierProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  calls = 0;
  async classify() {
    this.calls++;
    return { scores: { ...ZERO_SCORES, spam: 0.99 }, language: 'en' };
  }
}

function deps(o: Partial<CheckDeps> = {}): CheckDeps & { classifier: FakeClassifier } {
  const set = compileRuleSet([], { ownDomains: [] }, 'v1');
  return {
    rules: { get: async () => set },
    thresholds: { policy: async () => DEFAULT_THRESHOLDS },
    policies: { enabledForEvaluation: async () => [] },
    usage: { consume: async () => true },
    classifier: new FakeClassifier(),
    policyEvaluator: new DisabledPolicyEvaluator(),
    languages: ['en'],
    classifierTimeoutMs: 5000,
    policyTimeoutMs: 5000,
    policyMonthlyCallsPerBrand: 100,
    ...o,
  } as CheckDeps & { classifier: FakeClassifier };
}

async function withWorker<T>(d: CheckDeps, fn: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = [];
  const push = (level: string) => (msg: string, f?: object) =>
    void lines.push(JSON.stringify({ level, msg, ...f }));
  const log: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
  const w = startModerationCheckWorker({
    connection: redis.connection,
    prefix: redis.prefix,
    concurrency: 2,
    pool,
    deps: d,
    log,
  });
  try {
    return await fn(lines);
  } finally {
    await w.close();
  }
}

const data = (o: Partial<CheckJobData> = {}) => ({
  v: 1,
  organizationId: orgId,
  brandId,
  text: 'hello world',
  deadlineAt: Date.now() + 30_000,
  ...o,
});

async function run(payload: object): Promise<{ id: string; result: CheckJobResult }> {
  const job = await queue.add('check', payload, { removeOnComplete: true, removeOnFail: true });
  return { id: job.id!, result: (await job.waitUntilFinished(events, 20_000)) as CheckJobResult };
}

describe('moderation-check worker', () => {
  it('runs the check and removes the finished job', async () => {
    const d = deps();
    await withWorker(d, async (lines) => {
      const { id, result } = await run(data());
      expect(result).toMatchObject({ kind: 'done', result: { verdict: 'review' } });
      expect(await queue.getJob(id)).toBeUndefined();
      const done = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'moderation_check.done');
      expect(done).toMatchObject({ organizationId: orgId, brandId, verdict: 'review' });
      expect(lines.join('\n')).not.toContain('hello world');
    });
    expect(d.classifier.calls).toBe(1);
  });

  it('expires jobs past their deadline without calling the classifier', async () => {
    const d = deps();
    await withWorker(d, async () => {
      expect((await run(data({ deadlineAt: Date.now() - 1 }))).result).toEqual({
        kind: 'expired',
      });
    });
    expect(d.classifier.calls).toBe(0);
  });

  it('reports brand_gone for another org brand and for an archived brand', async () => {
    const d = deps();
    await withWorker(d, async () => {
      for (const id of [otherOrgBrandId, archivedBrandId, randomUUID()]) {
        expect((await run(data({ brandId: id }))).result).toEqual({ kind: 'brand_gone' });
      }
    });
    expect(d.classifier.calls).toBe(0);
  });

  it('rejects malformed jobs with a data-free failure and removes them', async () => {
    await withWorker(deps(), async () => {
      for (const payload of [
        { ...data({ text: MARKER }), extra: 1 },
        data({ text: `${MARKER}\u0000` }),
      ]) {
        const job = await queue.add('check', payload, {
          removeOnComplete: true,
          removeOnFail: true,
        });
        await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow(/^invalid_check_job$/);
        expect(await queue.getJob(job.id!)).toBeUndefined();
      }
    });
  });

  it('hides unexpected errors and never logs the text', async () => {
    const d = deps({
      rules: {
        get: async () => {
          throw new Error(`boom ${MARKER}`);
        },
      },
    });
    await withWorker(d, async (lines) => {
      const job = await queue.add('check', data({ text: MARKER }), {
        removeOnComplete: true,
        removeOnFail: true,
      });
      await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow(
        /^moderation_check_failed$/,
      );
      expect(lines.some((l) => l.includes('moderation_check.failed'))).toBe(true);
      expect(lines.join('\n')).not.toContain(MARKER);
    });
  });

  it('writes nothing to Postgres', async () => {
    const before = await counts();
    await withWorker(deps(), async () => {
      await run(data());
      await run(data({ brandId: archivedBrandId }));
    });
    expect(await counts()).toEqual(before);
  });

  it('closes with no jobs in flight', async () => {
    await withWorker(deps(), async () => {
      await run(data());
    });
    expect(await queue.getActiveCount()).toBe(0);
  });
});
