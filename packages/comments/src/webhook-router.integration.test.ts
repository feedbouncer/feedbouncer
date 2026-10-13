import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgConnectionDirectory, type InboundEvent } from '@feedbouncer/connectors';
import type { EnqueueRequest, EnqueueResult } from '@feedbouncer/jobs';
import { createLogger } from '@feedbouncer/service-runtime';
import { routeWebhookDelivery } from './webhook-router.js';

const lines: string[] = [];
const log = createLogger('comments-webhook-router-test', 'info', (l) => lines.push(l));

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let A: Tenant;
let B: Tenant & { liveConnectionId: string };

const ev = (
  page: string,
  post: string,
  comment: string,
  type: InboundEvent['type'],
  sec = Math.floor(Date.now() / 1000),
): InboundEvent => ({
  type,
  externalAccountId: page,
  ref: { sourceExternalId: post, externalId: comment },
  occurredAt: new Date(sec * 1000),
});
const producerOk = () =>
  vi.fn<(r: EnqueueRequest) => Promise<EnqueueResult>>(async () => ({
    status: 'enqueued',
    ledgerId: 'l',
    jobId: 'j',
  }));

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'webhook-router-test', onIdleError: () => {} });
  A = await seedTenant(ctx.c, 'route-a');
  const b = await seedTenant(ctx.c, 'route-b');
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    '900',
    A.connectionId,
  ]);
  // Brand B once connected page 900 too, then disconnected it; its live connection is page 901.
  await ctx.c.query(
    `UPDATE connection SET external_account_id = '900', status = 'revoked', status_reason = 'user_disconnected'
      WHERE id = $1`,
    [b.connectionId],
  );
  const live = await ctx.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, 'facebook', '901') RETURNING id`,
    [b.organizationId, b.brandId],
  );
  B = { ...b, liveConnectionId: live.rows[0]!.id };
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

describe('routeWebhookDelivery', () => {
  it('routes events only to the live connection for that page', async () => {
    lines.length = 0;
    const enqueue = producerOk();
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
    });
    await route({
      platform: 'facebook',
      connectionId: null,
      deliveryKey: 'k',
      events: [
        ev('900', '900_1', '900_1_1', 'comment.created'),
        ev('901', '901_1', '901_1_1', 'comment.updated', 1_760_000_100),
        ev('999', '999_1', '999_1_1', 'comment.created'), // unknown page
      ],
    });
    expect(enqueue.mock.calls.map(([r]) => [r.scope.brandId, r.type, r.payload])).toEqual([
      [
        A.brandId,
        'comment_ingest',
        {
          sourceExternalId: '900_1',
          commentExternalId: '900_1_1',
          event: 'created',
          platformEventSec: expect.any(Number),
          changeId: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ],
      [
        B.brandId,
        'comment_ingest',
        {
          sourceExternalId: '901_1',
          commentExternalId: '901_1_1',
          event: 'updated',
          platformEventSec: 1_760_000_100,
          changeId: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ],
    ]);
    expect(enqueue.mock.calls.map(([r]) => r.scope)).toEqual([
      { organizationId: A.organizationId, brandId: A.brandId, connectionId: A.connectionId },
      { organizationId: B.organizationId, brandId: B.brandId, connectionId: B.liveConnectionId },
    ]);
    expect(lines.join()).toContain('webhook.unrouted_events');
    expect(JSON.parse(lines.find((l) => l.includes('webhook.unrouted_events'))!)).toMatchObject({
      platform: 'facebook',
      count: 1,
    });
  });

  it('gives two same-second edits of one comment different change ids, stable across redelivery', async () => {
    const enqueue = producerOk();
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
    });
    const events = [
      ev('900', '900_1', '900_1_6', 'comment.updated', 1_760_000_300),
      ev('900', '900_1', '900_1_6', 'comment.updated', 1_760_000_300),
    ];
    const delivery = {
      platform: 'facebook',
      connectionId: null,
      deliveryKey: 'k5',
      events,
    } as const;
    await route(delivery);
    await route(delivery);
    const ids = enqueue.mock.calls.map(([r]) => (r.payload as { changeId: string }).changeId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.slice(2)).toEqual(ids.slice(0, 2));
  });

  it('maps deletes and looks each page up once per delivery', async () => {
    const enqueue = producerOk();
    const directory = new PgConnectionDirectory(pool);
    const lookup = vi.spyOn(directory, 'findLiveByAccount');
    const route = routeWebhookDelivery({ directory, producer: { enqueue }, log });
    await route({
      platform: 'facebook',
      connectionId: null,
      deliveryKey: 'k2',
      events: [
        ev('900', '900_1', '900_1_2', 'comment.deleted', 1_760_000_200),
        ev('900', '900_1', '900_1_3', 'comment.created'),
      ],
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls.map(([r]) => (r.payload as { event: string }).event)).toEqual([
      'deleted',
      'created',
    ]);
  });

  it('still enqueues for a connection that needs reconnecting (events retained)', async () => {
    await ctx.c.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1",
      [A.connectionId],
    );
    try {
      const enqueue = producerOk();
      const route = routeWebhookDelivery({
        directory: new PgConnectionDirectory(pool),
        producer: { enqueue },
        log,
      });
      await route({
        platform: 'facebook',
        connectionId: null,
        deliveryKey: 'k3',
        events: [ev('900', '900_1', '900_1_4', 'comment.created')],
      });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0]![0].scope.connectionId).toBe(A.connectionId);
    } finally {
      await ctx.c.query(
        "UPDATE connection SET status = 'active', status_reason = NULL WHERE id = $1",
        [A.connectionId],
      );
    }
  });

  it('propagates enqueue failures so the gate does not mark the delivery processed', async () => {
    const enqueue = vi.fn(async (): Promise<EnqueueResult> => {
      throw new Error('queue down');
    });
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
    });
    await expect(
      route({
        platform: 'facebook',
        connectionId: null,
        deliveryKey: 'k4',
        events: [ev('900', '900_1', '900_1_5', 'comment.created')],
      }),
    ).rejects.toThrow('queue down');
  });
});

describe('routeWebhookDelivery for instagram', () => {
  const IG_A = '17841400000000900';
  const IG_B = '17841400000000901';
  let igA: { organizationId: string; brandId: string; connectionId: string };
  let igB: { organizationId: string; brandId: string; connectionId: string };

  beforeAll(async () => {
    const insert = async (
      t: { organizationId: string; brandId: string },
      platform: string,
      account: string,
      revoked = false,
    ) =>
      (
        await ctx.c.query<{ id: string }>(
          `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, status_reason)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            t.organizationId,
            t.brandId,
            platform,
            account,
            revoked ? 'revoked' : 'active',
            revoked ? 'user_disconnected' : null,
          ],
        )
      ).rows[0]!.id;
    // Brand B once connected IG_A and disconnected it; its live Instagram account is IG_B.
    await insert(B, 'instagram', IG_A, true);
    igA = {
      organizationId: A.organizationId,
      brandId: A.brandId,
      connectionId: await insert(A, 'instagram', IG_A),
    };
    igB = {
      organizationId: B.organizationId,
      brandId: B.brandId,
      connectionId: await insert(B, 'instagram', IG_B),
    };
    // A Facebook connection whose Page id happens to equal an Instagram id never receives Instagram events.
    await insert(B, 'facebook', IG_A);
  });

  it('instagram events route only to the live connection for that IG account; unknown accounts are logged unrouted', async () => {
    lines.length = 0;
    const enqueue = producerOk();
    const route = routeWebhookDelivery({
      directory: new PgConnectionDirectory(pool),
      producer: { enqueue },
      log,
    });
    await route({
      platform: 'instagram',
      connectionId: null,
      deliveryKey: 'ig-k1',
      events: [
        ev(IG_A, '17900000000000001', '17800000000000001', 'comment.created'),
        ev(IG_B, '17900000000000002', '17800000000000002', 'comment.created', 1_760_000_400),
        ev('17841400000000999', '17900000000000003', '17800000000000003', 'comment.created'),
        ev('17841400000000998', '17900000000000004', '17800000000000004', 'comment.created'),
      ],
    });
    expect(enqueue.mock.calls.map(([r]) => [r.scope, r.platform, r.type, r.payload])).toEqual([
      [
        igA,
        'instagram',
        'comment_ingest',
        {
          sourceExternalId: '17900000000000001',
          commentExternalId: '17800000000000001',
          event: 'created',
          platformEventSec: expect.any(Number),
          changeId: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ],
      [
        igB,
        'instagram',
        'comment_ingest',
        {
          sourceExternalId: '17900000000000002',
          commentExternalId: '17800000000000002',
          event: 'created',
          platformEventSec: 1_760_000_400,
          changeId: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ],
    ]);
    const unrouted = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'webhook.unrouted_events');
    expect(unrouted).toEqual([expect.objectContaining({ platform: 'instagram', count: 2 })]);
  });

  it('1000 instagram events in one delivery are all enqueued', async () => {
    const enqueue = producerOk();
    const directory = new PgConnectionDirectory(pool);
    const lookup = vi.spyOn(directory, 'findLiveByAccount');
    const route = routeWebhookDelivery({ directory, producer: { enqueue }, log });
    const events = Array.from({ length: 1000 }, (_, i) =>
      ev(
        i % 2 === 0 ? IG_A : IG_B,
        '17900000000000009',
        `1780000001${String(i).padStart(7, '0')}`,
        'comment.created',
        1_760_000_500,
      ),
    );
    await route({ platform: 'instagram', connectionId: null, deliveryKey: 'ig-burst', events });
    expect(enqueue).toHaveBeenCalledTimes(1000);
    expect(lookup).toHaveBeenCalledTimes(2);
    const payloads = enqueue.mock.calls.map(
      ([r]) => r.payload as { commentExternalId: string; changeId: string },
    );
    expect(new Set(payloads.map((p) => p.commentExternalId)).size).toBe(1000);
    expect(new Set(payloads.map((p) => p.changeId)).size).toBe(1000);
    expect(
      enqueue.mock.calls.filter(([r]) => r.scope.connectionId === igA.connectionId),
    ).toHaveLength(500);
    expect(
      enqueue.mock.calls.filter(([r]) => r.scope.connectionId === igB.connectionId),
    ).toHaveLength(500);
  });
});
