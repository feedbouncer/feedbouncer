import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { ModerationActions } from './actions.js';
import { connectionLifecycleJob } from './jobs/lifecycle.js';
import { LIFECYCLE_JOB, TIKTOK_ADS_POLL_JOB } from './jobs/specs.js';
import { tiktokAdsPollJob } from './tiktok/poll-ads.js';
import { SETTINGS, log, tiktokWorld, type TikTokWorld } from './tiktok/test-world.js';

let w: TikTokWorld;
beforeAll(async () => {
  w = await tiktokWorld('disconnect');
});
afterAll(() => w.close());

const count = async (
  table: 'comment' | 'moderation_action' | 'connection_secret',
  s: ConnectionScope,
) =>
  Number(
    (
      await w.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
        [s.organizationId, s.brandId, s.connectionId],
      )
    ).rows[0]!.n,
  );

describe('disconnecting a TikTok connection', () => {
  it('disconnecting a tiktok_ads connection deletes its tokens, stops scheduling, keeps comments and actions', async () => {
    w.reset();
    const tenant = await w.tenant('ads');
    const { scope, advertiserId } = await w.connectAds(tenant);
    const [adId, itemId] = ['1900000000000000001', '1900000000000000002'];
    for (let i = 0; i < 3; i++)
      w.fake.addAdComment(advertiserId, {
        adId: adId!,
        itemId: itemId!,
        text: `c${i}`,
        createdAt: new Date(w.clock.now() - 60_000 * (i + 2)),
      });
    await tiktokAdsPollJob({
      runtime: w.runtime,
      polling: w.polling,
      store: w.store,
      clock: w.now,
      settings: SETTINGS,
    }).handle(w.jobCtx(scope, 'tiktok_ads', TIKTOK_ADS_POLL_JOB.type), {
      connectionId: scope.connectionId,
    });
    const [comment] = await w.comments(scope);
    const commentId = (
      await w.pool.query<{ id: string }>(
        'SELECT id FROM comment WHERE organization_id = $1 AND connection_id = $2 AND external_id = $3',
        [scope.organizationId, scope.connectionId, comment!.external_id],
      )
    ).rows[0]!.id;
    const producer = {
      enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
    };
    const requested = await new ModerationActions({
      pool: w.pool,
      store: w.store,
      producer,
      capabilities: (p) => w.registry.get(p)?.capabilities,
      clock: w.clock,
      log,
    }).request({
      scope,
      commentId,
      kind: 'hide',
      actor: { type: 'user', userId: tenant.userId },
      requestKey: `rk-${randomUUID()}`,
    });
    expect(requested.status).toBe('accepted');

    const before = {
      comments: await count('comment', scope),
      actions: await count('moderation_action', scope),
    };
    expect(before).toEqual({ comments: 3, actions: 1 });
    expect(await count('connection_secret', scope)).toBeGreaterThan(0);
    w.advance((SETTINGS.adsPollIntervalSec + 1) * 1000);
    expect(
      (await w.polling.dueConnections('tiktok_ads', w.now(), 1000)).map((d) => d.connectionId),
    ).toContain(scope.connectionId);

    expect(await w.directory.disconnect(scope, tenant.userId)).toBe(true);
    const teardown = connectionLifecycleJob({ runtime: w.runtime, log });
    await teardown.handle(w.jobCtx(scope, 'tiktok_ads', LIFECYCLE_JOB.type), {
      op: 'teardown',
      nonce: `${scope.connectionId}:1`,
    });

    expect(await count('connection_secret', scope)).toBe(0);
    expect(
      (await w.polling.dueConnections('tiktok_ads', w.now(), 1000)).map((d) => d.connectionId),
    ).not.toContain(scope.connectionId);
    expect({
      comments: await count('comment', scope),
      actions: await count('moderation_action', scope),
    }).toEqual(before);
  });
});
