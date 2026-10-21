import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { testRedis, type TestRedis } from '@feedbouncer/jobs/testing';
import {
  PRIVACY_QUEUE,
  PgPrivacyRequestStore,
  loadRetentionSettings,
  runPurge,
  type NewPrivacyRequest,
} from '@feedbouncer/privacy';
import { testKeyring } from '@feedbouncer/secrets/testing';
import type { Logger } from '@feedbouncer/service-runtime';
import { startPrivacyRequestWorker } from './privacy-requests.js';

const X = 'X-psid-6602';
const X_HANDLE = 'xavier.handle';
const X_NAME = 'Xenia Subject';
const MARKER = 'BODY-MARKER-4d1e';
const keys = testKeyring();

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
let redis: TestRedis;
let queue: Queue;
let store: PgPrivacyRequestStore;
let dir: string;
let A: Tenant;
let lines: string[];
let log: Logger;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'privacy-worker-test', onIdleError: () => {} });
  redis = testRedis();
  queue = new Queue(PRIVACY_QUEUE, { connection: redis.connection, prefix: redis.prefix });
  store = new PgPrivacyRequestStore(pool, keys);
});
afterAll(async () => {
  await queue.close();
  await redis.cleanup();
  await pool.end();
  await h.close();
});
beforeEach(async () => {
  await h.c.query('DELETE FROM organization');
  A = await seedTenant(h.c, 'a');
  dir = await mkdtemp(path.join(tmpdir(), 'fb-privacy-worker-'));
  lines = [];
  const push = (level: string) => (msg: string, f?: object) =>
    void lines.push(JSON.stringify({ level, msg, ...f }));
  log = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
  await seedSubject();
  return () => rm(dir, { recursive: true, force: true });
});

async function seedSubject() {
  const authorId = (
    await h.c.query<{ id: string }>(
      `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [A.organizationId, A.brandId, A.connectionId, X, X_NAME],
    )
  ).rows[0]!.id;
  await h.c.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id, body, permalink, posted_at)
     VALUES ($1, $2, $3, $4, 'c-1', $5, $6, 'https://facebook.example/c-1', now())`,
    [A.organizationId, A.brandId, A.connectionId, A.sourceId, authorId, MARKER],
  );
}

const request = (o: Partial<NewPrivacyRequest> = {}): NewPrivacyRequest => ({
  organizationId: A.organizationId,
  kind: 'export',
  mode: 'execute',
  subjects: [{ platform: 'facebook', externalId: X, handle: X_HANDLE }],
  via: 'cli',
  actorUserId: null,
  actorLabel: 'ops-1',
  reference: null,
  keepRuleEntriesReason: null,
  ...o,
});

const comments = async () =>
  Number((await h.c.query<{ n: string }>('SELECT count(*) AS n FROM comment')).rows[0]!.n);
const status = async (id: string) =>
  (await h.c.query('SELECT * FROM privacy_request WHERE id = $1', [id])).rows[0];
const audits = async (action: string) =>
  (await h.c.query('SELECT details FROM audit_event WHERE action = $1', [action])).rows;

async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error('timed out');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
const finished = (id: string) => async () => ['done', 'failed'].includes((await status(id)).status);

function start(o: { store?: PgPrivacyRequestStore; sweepIntervalMs?: number } = {}) {
  return startPrivacyRequestWorker({
    connection: redis.connection,
    prefix: redis.prefix,
    concurrency: 2,
    sweepIntervalMs: o.sweepIntervalMs ?? 3_600_000,
    backoffMs: 20,
    log,
    deps: {
      store: o.store ?? store,
      pool,
      exportDir: dir,
      exportTtlHours: 5,
      batchSize: 100,
      log,
    },
  });
}

describe('privacy request worker', () => {
  it('writes an export, records its hash and expiry from the configured TTL, and audits it', async () => {
    const w = start();
    try {
      const { id } = await store.create(request());
      await w.enqueue(id);
      await until(finished(id));
      const r = await status(id);
      expect(r).toMatchObject({ status: 'done', found: true, subjects_sealed: null });
      const file = await readFile(path.join(dir, `${id}.zip`));
      expect(r.export_sha256).toEqual(createHash('sha256').update(file).digest());
      expect(Number(r.export_bytes)).toBe(file.length);
      const ttlMs = r.export_expires_at.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(4.9 * 3_600_000);
      expect(ttlMs).toBeLessThanOrEqual(5 * 3_600_000);
      expect(await audits('privacy.export_completed')).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('a dry run changes nothing and an execute run erases', async () => {
    const w = start();
    try {
      const dry = await store.create(request({ kind: 'erasure', mode: 'dry_run' }));
      await w.enqueue(dry.id);
      await until(finished(dry.id));
      expect(await status(dry.id)).toMatchObject({ status: 'done', found: true });
      expect((await status(dry.id)).counts).toMatchObject({ comments: 1 });
      expect(await comments()).toBe(1);
      expect(await audits('privacy.erasure_dry_run_completed')).toHaveLength(1);

      const run = await store.create(request({ kind: 'erasure' }));
      await w.enqueue(run.id);
      await until(finished(run.id));
      expect(await status(run.id)).toMatchObject({
        status: 'done',
        coverage: 'all_ingested_before_completed_at',
      });
      expect(await comments()).toBe(0);
      expect(await audits('privacy.erasure_completed')).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('processes a request enqueued twice once', async () => {
    const w = start();
    try {
      const { id } = await store.create(request());
      await Promise.all([w.enqueue(id), w.enqueue(id)]);
      await w.enqueue(id);
      await until(finished(id));
      await new Promise((r) => setTimeout(r, 300));
      expect(await audits('privacy.export_completed')).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('the sweeper enqueues a queued request whose job was lost', async () => {
    const { id } = await store.create(request());
    await h.c.query(
      "UPDATE privacy_request SET created_at = now() - interval '10 minutes' WHERE id = $1",
      [id],
    );
    const w = start({ sweepIntervalMs: 50 });
    try {
      await until(finished(id));
      expect((await status(id)).status).toBe('done');
    } finally {
      await w.close();
    }
  });

  it('the sweeper rescues a running request whose job ended in the failed set', async () => {
    class Unrecordable extends PgPrivacyRequestStore {
      override finish(): Promise<void> {
        return Promise.reject(new Error('cannot finish'));
      }
      override fail(): Promise<void> {
        return Promise.reject(new Error('cannot fail'));
      }
    }
    const { id } = await store.create(request());
    const crashing = start({ store: new Unrecordable(pool, keys) });
    try {
      await crashing.enqueue(id);
      await until(async () => (await queue.getJob(id))?.finishedOn !== undefined);
    } finally {
      await crashing.close();
    }
    expect(await queue.getJob(id).then((j) => j?.getState())).toBe('failed');
    expect((await status(id)).status).toBe('running');
    await h.c.query(
      "UPDATE privacy_request SET heartbeat_at = now() - interval '1 hour' WHERE id = $1",
      [id],
    );
    const w = start({ sweepIntervalMs: 50 });
    try {
      await until(finished(id));
      expect((await status(id)).status).toBe('done');
    } finally {
      await w.close();
    }
  });

  it('retries a failed attempt, then fails with a data-free reason and wipes the identifiers', async () => {
    class Failing extends PgPrivacyRequestStore {
      override finish(): Promise<void> {
        return Promise.reject(new Error(`cannot store ${X} ${X_HANDLE} ${X_NAME} ${MARKER}`));
      }
    }
    const w = start({ store: new Failing(pool, keys) });
    try {
      const { id } = await store.create(request());
      await w.enqueue(id);
      await until(finished(id));
      expect(await status(id)).toMatchObject({
        status: 'failed',
        error_code: 'internal_error',
        subjects_sealed: null,
      });
      const job = await queue.getJob(id);
      expect(job?.failedReason).toBe('privacy_request_failed');
      expect(job?.attemptsMade).toBe(3);
      expect(JSON.stringify(job?.stacktrace)).not.toContain(X);
      expect(await audits('privacy.request_failed')).toHaveLength(1);
      const all = lines.join('\n');
      for (const secret of [X, X_HANDLE, X_NAME, MARKER]) expect(all).not.toContain(secret);
      expect(lines.some((l) => l.includes('privacy.request_failed'))).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('keeps identifiers, names and bodies out of every audit row and log line', async () => {
    const w = start();
    try {
      for (const o of [{}, { kind: 'erasure', mode: 'dry_run' }, { kind: 'erasure' }] as const) {
        const { id } = await store.create(request({ ...o, reference: 'TICKET-9' }));
        await w.enqueue(id);
        await until(finished(id));
      }
    } finally {
      await w.close();
    }
    const everything =
      JSON.stringify((await h.c.query('SELECT details FROM audit_event')).rows) + lines.join('\n');
    for (const secret of [X, X_HANDLE, X_NAME, MARKER]) expect(everything).not.toContain(secret);
  });

  it('a retried export replaces a file left by a crashed attempt', async () => {
    const { id } = await store.create(request());
    await writeFile(path.join(dir, `${id}.zip`), 'stale');
    await writeFile(path.join(dir, `${id}.zip.part`), 'stale');
    const w = start();
    try {
      await w.enqueue(id);
      await until(finished(id));
      expect((await status(id)).status).toBe('done');
      expect((await readFile(path.join(dir, `${id}.zip`))).subarray(0, 2).toString()).toBe('PK');
    } finally {
      await w.close();
    }
  });

  it('the retention loop deletes an expired export file and clears its columns', async () => {
    const w = start();
    let id: string;
    try {
      ({ id } = await store.create(request()));
      await w.enqueue(id);
      await until(finished(id));
    } finally {
      await w.close();
    }
    await h.c.query(
      "UPDATE privacy_request SET export_expires_at = now() - interval '1 minute' WHERE id = $1",
      [id],
    );
    await runPurge(pool, loadRetentionSettings({}), { log, exportDir: dir });
    await expect(stat(path.join(dir, `${id}.zip`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await status(id)).toMatchObject({
      export_sha256: null,
      export_bytes: null,
      export_expires_at: null,
    });
  });

  it('ignores a job for a request that does not exist', async () => {
    const w = start();
    try {
      const id = randomUUID();
      await w.enqueue(id);
      await until(async () => (await queue.getJob(id)) === undefined);
    } finally {
      await w.close();
    }
  });
});
