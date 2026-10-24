import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { tiktokWorld, type TikTokWorld } from './test-world.js';

let w: TikTokWorld;
beforeAll(async () => {
  w = await tiktokWorld('polling');
});
afterAll(() => w.close());

const video = (externalId: string) => ({
  externalId,
  kind: 'video' as const,
  permalink: null,
  active: true,
});

describe('PgTikTokPolling', () => {
  it('dueConnections returns only active connections of the platform, ids only', async () => {
    const a = await w.tenant('due-a');
    const b = await w.tenant('due-b');
    const activeA = await w.insertConnection(a, 'tiktok', 'tt-a-1', 'tok');
    const pausedA = await w.insertConnection(a, 'tiktok', 'tt-a-2', 'tok', 'paused');
    const reconnectB = await w.insertConnection(b, 'tiktok', 'tt-b-1', 'tok', 'reconnect_required');
    const activeB = await w.insertConnection(b, 'tiktok', 'tt-b-2', 'tok');
    const adsA = await w.insertConnection(a, 'tiktok_ads', '9001', 'tok');
    const notDueB = await w.insertConnection(b, 'tiktok', 'tt-b-3', 'tok');
    await w.polling.connectionState(notDueB, 'tiktok_videos');
    await w.polling.saveConnectionState(notDueB, {
      nextPollAt: new Date(w.clock.now() + 60_000),
    });

    const due = await w.polling.dueConnections('tiktok', w.now(), 100);
    const ids = due.map((d) => d.connectionId);
    expect(ids).toEqual(expect.arrayContaining([activeA.connectionId, activeB.connectionId]));
    for (const s of [pausedA, reconnectB, adsA, notDueB]) expect(ids).not.toContain(s.connectionId);
    for (const d of due)
      expect(Object.keys(d).sort()).toEqual(['brandId', 'connectionId', 'organizationId']);
    expect(due.find((d) => d.connectionId === activeB.connectionId)).toEqual(activeB);

    const adsDue = await w.polling.dueConnections('tiktok_ads', w.now(), 100);
    expect(adsDue.map((d) => d.connectionId)).toContain(adsA.connectionId);
    expect(adsDue.map((d) => d.connectionId)).not.toContain(activeA.connectionId);

    // A connection with a due video is due even before its next discovery.
    await w.polling.upsertSources(notDueB, [video('v-due')]);
    expect(
      (await w.polling.dueConnections('tiktok', w.now(), 100)).map((d) => d.connectionId),
    ).toContain(notDueB.connectionId);
  });

  it("claimDueVideos never returns another tenant's source", async () => {
    const a = await w.tenant('claim-a');
    const b = await w.tenant('claim-b');
    const sa = await w.insertConnection(a, 'tiktok', 'tt-ca', 'tok');
    const sb = await w.insertConnection(b, 'tiktok', 'tt-cb', 'tok');
    await w.polling.upsertSources(sa, [video('va-1'), video('va-2')]);
    await w.polling.upsertSources(sb, [video('vb-1')]);
    const claimedA = await w.polling.claimDueVideos(sa, w.now(), 10);
    expect(claimedA.map((c) => c.externalId).sort()).toEqual(['va-1', 'va-2']);
    // Scope mismatch: b's connection id under a's organization finds nothing.
    const forged: ConnectionScope = { ...sa, connectionId: sb.connectionId };
    expect(await w.polling.claimDueVideos(forged, w.now(), 10)).toEqual([]);
    expect((await w.polling.claimDueVideos(sb, w.now(), 10)).map((c) => c.externalId)).toEqual([
      'vb-1',
    ]);
  });

  it('concurrent claims skip locked rows', async () => {
    const a = await w.tenant('skip');
    const s = await w.insertConnection(a, 'tiktok', 'tt-skip', 'tok');
    await w.polling.upsertSources(s, ['s1', 's2', 's3', 's4'].map(video));
    const [x, y] = await Promise.all([
      w.polling.claimDueVideos(s, w.now(), 2),
      w.polling.claimDueVideos(s, w.now(), 2),
    ]);
    const all = [...x!, ...y!].map((c) => c.externalId);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(['s1', 's2', 's3', 's4']);
    // Claimed rows stay leased until their poll is saved.
    expect(await w.polling.claimDueVideos(s, w.now(), 10)).toEqual([]);
  });

  it('connectionState creates the row once and saves patches', async () => {
    const a = await w.tenant('state');
    const s = await w.insertConnection(a, 'tiktok_ads', '9002', 'tok');
    const st = await w.polling.connectionState(s, 'tiktok_ad_comments');
    expect(st).toMatchObject({ highWaterAt: null, resumePage: null, passStartedAt: null });
    await w.polling.saveConnectionState(s, { resumePage: 3, passStartedAt: w.now() });
    expect(await w.polling.connectionState(s, 'tiktok_ad_comments')).toMatchObject({
      resumePage: 3,
      passStartedAt: w.now(),
    });
    await expect(w.polling.connectionState(s, 'tiktok_videos')).rejects.toThrow();
  });
});
