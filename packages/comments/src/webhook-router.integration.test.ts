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
