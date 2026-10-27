import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { PgConnectionDirectory, type InboundEvent } from '@feedbouncer/connectors';
import type { EnqueueRequest, EnqueueResult } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { createLogger } from '@feedbouncer/service-runtime';
import { routeWebhookDelivery } from '../webhook-router.js';
import { PgThreadsPolling } from './polling.js';
import { threadsWakeSink } from './wake-sink.js';

const lines: string[] = [];
const log = createLogger('comments-threads-wake-test', 'info', (l) => lines.push(l));

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let polling: PgThreadsPolling;
let A: ConnectionScope;
let B: ConnectionScope;
let stale: ConnectionScope;
let n = 0;
const nextId = () => `1790000${String(++n).padStart(10, '0')}`;

const insertThreads = async (
  t: { organizationId: string; brandId: string },
  account: string,
  status = 'active',
): Promise<ConnectionScope> => {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, status_reason)
     VALUES ($1, $2, 'threads', $3, $4, $5) RETURNING id`,
    [t.organizationId, t.brandId, account, status, status === 'active' ? null : 'token_expired'],
  );
  return { organizationId: t.organizationId, brandId: t.brandId, connectionId: r.rows[0]!.id };
};

const pending = async (scope: ConnectionScope) =>
  (
    await pool.query<{ external_id: string; source_external_id: string; attempts: number }>(
      `SELECT external_id, source_external_id, attempts FROM threads_pending_reply
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 ORDER BY external_id`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    )
  ).rows;

const sourceOf = async (scope: ConnectionScope, externalId: string) =>
  (
    await pool.query<{ kind: string; next_poll_at: Date; owner_verified: boolean | null }>(
      `SELECT s.kind, sp.next_poll_at, sp.owner_verified FROM source s
         JOIN source_poll sp ON sp.source_id = s.id
        WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.connection_id = $3
          AND s.external_id = $4`,
      [scope.organizationId, scope.brandId, scope.connectionId, externalId],
    )
  ).rows;

const ev = (account: string, post: string, reply: string): InboundEvent => ({
  type: 'comment.created',
  externalAccountId: account,
  ref: { sourceExternalId: post, externalId: reply },
  occurredAt: new Date(),
});

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'threads-wake-test', onIdleError: () => {} });
  polling = new PgThreadsPolling(pool);
  const a = await seedTenant(ctx.c, 'thr-a');
  const b = await seedTenant(ctx.c, 'thr-b');
  A = await insertThreads(a, '1784000000000001');
  B = await insertThreads(b, '1784000000000002');
  stale = await insertThreads(b, '1784000000000003', 'reconnect_required');
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

describe('PgThreadsPolling.recordWake', () => {
  it('creates the thread source, makes it due at the wake time and records the reply as pending', async () => {
    const post = nextId();
    const reply = nextId();
    const at = new Date(Date.now() - 1000);
    await polling.recordWake(A, { sourceExternalId: post, replyExternalId: reply, receivedAt: at });
    expect(await sourceOf(A, post)).toEqual([
      { kind: 'thread', next_poll_at: at, owner_verified: null },
    ]);
    expect(await pending(A)).toEqual(
      expect.arrayContaining([{ external_id: reply, source_external_id: post, attempts: 0 }]),
    );
  });

  it('pulls a later next_poll_at forward but never pushes an earlier one back', async () => {
    const post = nextId();
    const early = new Date(Date.now() - 60_000);
    await polling.recordWake(A, {
      sourceExternalId: post,
      replyExternalId: nextId(),
      receivedAt: early,
    });
    await polling.recordWake(A, {
      sourceExternalId: post,
      replyExternalId: nextId(),
      receivedAt: new Date(),
    });
    expect((await sourceOf(A, post))[0]!.next_poll_at).toEqual(early);

    const later = new Date(Date.now() + 3_600_000);
    await pool.query(
      `UPDATE source_poll SET next_poll_at = $2 WHERE source_id =
         (SELECT id FROM source WHERE connection_id = $1 AND external_id = $3)`,
      [A.connectionId, later, post],
    );
    const now = new Date();
    await polling.recordWake(A, {
      sourceExternalId: post,
      replyExternalId: nextId(),
      receivedAt: now,
    });
    expect((await sourceOf(A, post))[0]!.next_poll_at).toEqual(now);
  });

  it('the same reply woken twice is one pending row', async () => {
    const post = nextId();
    const reply = nextId();
    for (let i = 0; i < 2; i++)
      await polling.recordWake(B, {
        sourceExternalId: post,
        replyExternalId: reply,
        receivedAt: new Date(),
      });
    expect((await pending(B)).filter((p) => p.external_id === reply)).toHaveLength(1);
  });

  it('records no pending reply for a source already found to belong to another account', async () => {
    const post = nextId();
    await polling.recordWake(A, {
      sourceExternalId: post,
      replyExternalId: nextId(),
      receivedAt: new Date(),
    });
    await pool.query(
      `UPDATE source_poll SET owner_verified = false WHERE source_id =
         (SELECT id FROM source WHERE connection_id = $1 AND external_id = $2)`,
      [A.connectionId, post],
    );
    await pool.query(
      'DELETE FROM threads_pending_reply WHERE connection_id = $1 AND source_external_id = $2',
      [A.connectionId, post],
    );
    await polling.recordWake(A, {
      sourceExternalId: post,
      replyExternalId: nextId(),
      receivedAt: new Date(),
    });
    expect((await pending(A)).filter((p) => p.source_external_id === post)).toEqual([]);
  });

  it('refuses a scope whose connection belongs to another tenant, storing nothing', async () => {
    const post = nextId();
    const forged = { ...A, connectionId: B.connectionId };
    await expect(
      polling.recordWake(forged, {
        sourceExternalId: post,
        replyExternalId: nextId(),
        receivedAt: new Date(),
      }),
    ).rejects.toThrow();
    const leaked = await pool.query('SELECT 1 FROM source WHERE external_id = $1', [post]);
    expect(leaked.rows).toEqual([]);
  });
});

describe('routeWebhookDelivery with a threads sink', () => {
  const enqueue = vi.fn<(r: EnqueueRequest) => Promise<EnqueueResult>>();

  it('records wake-ups instead of enqueueing ingest jobs, and counts unrouted accounts', async () => {
    lines.length = 0;
    enqueue.mockClear();
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
      sinks: { threads: threadsWakeSink(polling) },
    });
    const post = nextId();
    const reply = nextId();
    await route({
      platform: 'threads',
      connectionId: null,
      deliveryKey: 'thr-k1',
      events: [ev('1784000000000002', post, reply), ev('1784000000000999', nextId(), nextId())],
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await pending(B)).filter((p) => p.external_id === reply)).toHaveLength(1);
    expect((await sourceOf(B, post))[0]!.next_poll_at.getTime()).toBeLessThanOrEqual(Date.now());
    const unrouted = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'webhook.unrouted_events');
    expect(unrouted).toEqual([expect.objectContaining({ platform: 'threads', count: 1 })]);
  });

  it('a reconnect_required connection still records the wake, to be polled after reconnect', async () => {
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
      sinks: { threads: threadsWakeSink(polling) },
    });
    const reply = nextId();
    await route({
      platform: 'threads',
      connectionId: null,
      deliveryKey: 'thr-k2',
      events: [ev('1784000000000003', nextId(), reply)],
    });
    expect((await pending(stale)).map((p) => p.external_id)).toContain(reply);
  });

  it('a failing sink propagates, so the platform redelivers', async () => {
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
      sinks: {
        threads: async () => {
          throw new Error('db down');
        },
      },
    });
    await expect(
      route({
        platform: 'threads',
        connectionId: null,
        deliveryKey: 'thr-k3',
        events: [ev('1784000000000001', nextId(), nextId())],
      }),
    ).rejects.toThrow('db down');
  });

  it('sinks for one platform leave the others on the ingest job', async () => {
    enqueue.mockClear();
    enqueue.mockResolvedValue({ status: 'enqueued', ledgerId: 'l', jobId: 'j' });
    const t = await seedTenant(ctx.c, 'thr-fb');
    await ctx.c.query("UPDATE connection SET external_account_id = '777' WHERE id = $1", [
      t.connectionId,
    ]);
    const sink = vi.fn(async () => {});
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
      sinks: { threads: sink },
    });
    await route({
      platform: 'facebook',
      connectionId: null,
      deliveryKey: 'thr-k4',
      events: [ev('777', '777_1', '777_1_1')],
    });
    expect(sink).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
