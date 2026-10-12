import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProducerConnection } from './connections.js';
import { QueueSet } from './queues.js';
import { createJobsHarness, type JobsHarness } from './testing/index.js';

let h: JobsHarness;
beforeEach(async () => {
  h = await createJobsHarness();
});
afterEach(async () => {
  await h.cleanup();
});

const enqueue = (
  ref: string,
  steps: string[],
  platform: 'facebook' | 'youtube' = 'facebook',
  tenant: 0 | 1 = 0,
) =>
  h.producer.enqueue({
    scope: h.scope(tenant, platform),
    platform,
    type: 'scripted',
    payload: { ref, steps },
  });

describe('JobWorkers', () => {
  it('starts one consumer per registered platform', async () => {
    const w = await h.workers();
    expect(w.platforms().sort()).toEqual(['facebook', 'youtube']);
    expect(w.isRunning()).toBe(true);
  });

  it('isolates platforms: a stuck facebook queue does not delay youtube', async () => {
    const config = {
      ...h.config,
      concurrency: { ...h.config.concurrency, facebook: 1, youtube: 1 },
    };
    await h.workers({ config });
    const stuck = await enqueue('fb-stuck', ['hang']);
    await expect.poll(() => h.script.runs.get('fb-stuck')?.length ?? 0).toBe(1);
    const fbBehind = await enqueue('fb-behind', ['ok']);
    const yt = await Promise.all(['y1', 'y2', 'y3'].map((r) => enqueue(r, ['ok'], 'youtube')));
    const started = Date.now();
    for (const r of yt) await h.waitFor(r.ledgerId, ['completed'], 3_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await h.ledger.get(fbBehind.ledgerId))?.state).toBe('queued'); // still behind the stuck one
    h.script.release('fb-stuck');
    await h.waitFor(stuck.ledgerId, ['completed']);
    await h.waitFor(fbBehind.ledgerId, ['completed']);
  });

  it('retries transient failures with growing jittered delays, then completes', async () => {
    await h.workers();
    const r = await enqueue('flaky', ['transient', 'transient', 'ok']);
    const row = await h.waitFor(r.ledgerId, ['completed']);
    expect(row).toMatchObject({ failures: 2, lastErrorCode: 'upstream_5xx' });
    const [t0, t1, t2] = h.script.runs.get('flaky')!;
    expect(t1! - t0!).toBeGreaterThanOrEqual(50); // >= base/2
    expect(t2! - t1!).toBeGreaterThanOrEqual(t1! - t0! - 60); // equal jitter below the cap; 60 ms scheduler slack
    expect(h.metrics.count('retried', 'facebook')).toBe(2);
  });

  it('honours retry-after without consuming an attempt', async () => {
    await h.workers();
    const r = await enqueue('throttled', ['rate:1200', 'rate:1200', 'rate:1200', 'ok']); // 3 deferrals = maxAttempts
    const row = await h.waitFor(r.ledgerId, ['completed'], 15_000);
    expect(row).toMatchObject({ failures: 0, deferrals: 3 });
    const runs = h.script.runs.get('throttled')!;
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(1_200);
    }
  });

  it('sends non-retryable errors straight to the DLQ with a reason and full metadata', async () => {
    await h.workers();
    const r = await enqueue('bad', ['permanent']);
    await h.waitFor(r.ledgerId, ['dead_lettered']);
    const [e] = await h.ledger.listDeadLetters({ ids: [r.ledgerId], limit: 1 });
    expect(e).toMatchObject({
      reason: 'non_retryable',
      lastErrorKind: 'non_retryable',
      lastErrorCode: 'invalid_request',
      platform: 'facebook',
      jobType: 'scripted',
      failures: 1,
      payload: { ref: 'bad', steps: ['permanent'] },
      scope: h.scope(0, 'facebook'),
    });
    expect(e!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(e!.firstFailedAt).toBeInstanceOf(Date);
    expect(e!.lastFailedAt).toBeInstanceOf(Date);
    expect(h.script.runs.get('bad')).toHaveLength(1);
  });

  it('dead-letters needs-reconnection without retrying', async () => {
    await h.workers();
    const r = await enqueue('reauth', ['reauth']);
    await h.waitFor(r.ledgerId, ['dead_lettered']);
    expect((await h.ledger.get(r.ledgerId))?.deadLetterReason).toBe('needs_reconnection');
    expect(h.script.runs.get('reauth')).toHaveLength(1);
  });

  it('dead-letters after exhausting retries, and later jobs still run', async () => {
    await h.workers();
    const poison = await enqueue('always', ['throw']);
    const after = await enqueue('after', ['ok']);
    await h.waitFor(poison.ledgerId, ['dead_lettered']);
    await h.waitFor(after.ledgerId, ['completed']);
    expect(await h.ledger.get(poison.ledgerId)).toMatchObject({
      deadLetterReason: 'retries_exhausted',
      failures: 3,
    });
    expect(h.lines.join('\n')).not.toContain('SHOULD_NOT_LEAK');
  });

  it('replay reuses the original key and runs once', async () => {
    await h.workers();
    const r = await enqueue('replay-me', ['permanent', 'ok']);
    await h.waitFor(r.ledgerId, ['dead_lettered']);
    const keyBefore = (await h.ledger.get(r.ledgerId))!.idempotencyKey;
    await Promise.all([
      h.producer.replay({ ids: [r.ledgerId], limit: 1 }),
      h.producer.replay({ ids: [r.ledgerId], limit: 1 }),
    ]);
    const row = await h.waitFor(r.ledgerId, ['completed']);
    expect(row).toMatchObject({ replays: 1, idempotencyKey: keyBefore });
    expect(h.script.sideEffects.get('replay-me')).toBe(1);
    expect((await enqueue('replay-me', ['permanent', 'ok'])).status).toBe('deduplicated');
  });

  it('resolves a replayed job whose target is gone', async () => {
    await h.workers();
    const r = await enqueue('vanished', ['gone']);
    await h.waitFor(r.ledgerId, ['dead_lettered']);
    await h.producer.replay({ ids: [r.ledgerId], limit: 1 });
    const row = await h.waitFor(r.ledgerId, ['resolved']);
    expect(row.resolution).toBe('target_gone');
  });

  it('reports per-platform counts', async () => {
    await h.workers();
    const r = await enqueue('count-me', ['ok']);
    await enqueue('count-me', ['ok']);
    await h.waitFor(r.ledgerId, ['completed']);
    const snap = h.metrics.snapshot().facebook!;
    expect(snap.enqueued).toBeGreaterThanOrEqual(1);
    expect(snap.deduplicated).toBeGreaterThanOrEqual(1);
    expect(snap.completed).toBeGreaterThanOrEqual(1);
  });
});

describe('producer connection', () => {
  it('fails an enqueue instead of hanging when Redis was never reachable', async () => {
    const connection = createProducerConnection('redis://127.0.0.1:1/0');
    connection.on('error', () => {});
    const queues = new QueueSet({ connection, prefix: 'fbt-down', addTimeoutMs: 500 });
    const started = Date.now();
    try {
      await expect(queues.add('facebook', 'scripted', 'id', 'key')).rejects.toThrow(
        'enqueue timed out',
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      connection.disconnect();
      await queues.close().catch(() => {});
    }
  });

  it('fails an enqueue promptly when Redis goes away after connecting', async () => {
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(new URL(process.env.REDIS_URL!).port), '127.0.0.1');
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.on('error', () => {});
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const { port } = proxy.address() as net.AddressInfo;
    const connection = createProducerConnection(`redis://127.0.0.1:${port}/0`);
    connection.on('error', () => {});
    const prefix = `fbt-${randomBytes(4).toString('hex')}`;
    const queues = new QueueSet({ connection, prefix });
    try {
      await queues.add('facebook', 'scripted', 'id', 'key-up');
      proxy.close();
      for (const s of sockets) s.destroy();
      const started = Date.now();
      await expect(queues.add('facebook', 'scripted', 'id', 'key-down')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      connection.disconnect();
      await queues.close().catch(() => {});
      // Remove only this test's keys from the shared instance.
      const direct = new Redis(process.env.REDIS_URL!);
      const keys = await direct.keys(`${prefix}:*`);
      if (keys.length) await direct.del(...keys);
      direct.disconnect();
    }
  });
});
