import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { CLAIM_LEASE_MS } from '../tiktok/polling.js';
import { threadsWorld, type ThreadsWorld } from './test-world.js';

let w: ThreadsWorld;
beforeAll(async () => {
  w = await threadsWorld('polling');
});
afterAll(() => w.close());

const post = (externalId: string) => ({
  externalId,
  kind: 'thread' as const,
  permalink: null,
  active: true,
  postedAt: new Date('2026-10-20T10:00:00Z'),
});
const wake = (s: ConnectionScope, source: string, reply: string) =>
  w.polling.recordWake(s, {
    sourceExternalId: source,
    replyExternalId: reply,
    receivedAt: w.now(),
  });

describe('PgThreadsPolling', () => {
  it('dueConnections returns scopes only and skips revoked/paused/reconnect_required', async () => {
    const a = await w.tenant('due-a');
    const b = await w.tenant('due-b');
    const activeA = await w.insertConnection(a, '1001');
    const revoked = await w.insertConnection(a, '1002', 'revoked');
    const paused = await w.insertConnection(b, '1003', 'paused');
    const reconnect = await w.insertConnection(b, '1004', 'reconnect_required');
    const notDue = await w.insertConnection(b, '1005');
    await w.polling.discoveryState(notDue);
    await w.polling.saveDiscovery(notDue, { nextPollAt: new Date(w.clock.now() + 60_000) });

    const due = await w.polling.dueConnections(w.now(), 100);
    const ids = due.map((d) => d.connectionId);
    expect(ids).toContain(activeA.connectionId);
    for (const s of [revoked, paused, reconnect, notDue]) expect(ids).not.toContain(s.connectionId);
    for (const d of due)
      expect(Object.keys(d).sort()).toEqual(['brandId', 'connectionId', 'organizationId']);

    // A due post makes a connection due before its next discovery; a foreign post does not.
    await w.polling.upsertSources(notDue, [post('2001')]);
    expect((await w.polling.dueConnections(w.now(), 100)).map((d) => d.connectionId)).toContain(
      notDue.connectionId,
    );
    const [claimed] = await w.polling.claimDueSources(notDue, w.now(), 1);
    await w.polling.setOwnerVerified(notDue, claimed!.sourceId, false);
    await w.polling.saveSourcePoll(notDue, claimed!.sourceId, {
      nextPollAt: new Date(w.clock.now() - 1000),
    });
    expect((await w.polling.dueConnections(w.now(), 100)).map((d) => d.connectionId)).not.toContain(
      notDue.connectionId,
    );
  });

  it('every statement filters by org+brand+connection: a claim under org A never returns org B sources', async () => {
    const a = await w.tenant('claim-a');
    const b = await w.tenant('claim-b');
    const sa = await w.insertConnection(a, '1101');
    const sb = await w.insertConnection(b, '1102');
    await w.polling.upsertSources(sa, [post('2101'), post('2102')]);
    await w.polling.upsertSources(sb, [post('2103')]);
    await wake(sb, '2104', '3101');

    const forged: ConnectionScope = { ...sa, connectionId: sb.connectionId };
    expect(await w.polling.claimDueSources(forged, w.now(), 10)).toEqual([]);
    expect(await w.polling.pendingFor(forged, '2104', 10)).toEqual([]);
    expect(await w.polling.discoveryState(forged).catch(() => 'rejected')).toBe('rejected');
    const sourceB = (await w.polling.claimDueSources(sb, w.now(), 10)).find(
      (c) => c.externalId === '2104',
    )!;
    await w.polling.setOwnerVerified(forged, sourceB.sourceId, false);
    await w.polling.resolvePending(forged, ['3101']);
    await w.polling.bumpPending(forged, ['3101']);
    expect((await w.pending(sb)).map((p) => [p.external_id, p.attempts])).toEqual([['3101', 0]]);
    expect((await w.sourcePoll(sb, '2104'))!.owner_verified).toBeNull();

    const claimedA = await w.polling.claimDueSources(sa, w.now(), 10);
    expect(claimedA.map((c) => c.externalId).sort()).toEqual(['2101', '2102']);
    expect(claimedA[0]!.postedAt).toEqual(new Date('2026-10-20T10:00:00Z'));
  });

  it('claims are leased, ordered by next_poll_at, and skip foreign sources', async () => {
    const t = await w.tenant('lease');
    const s = await w.insertConnection(t, '1201');
    await w.polling.upsertSources(s, [post('2201'), post('2202'), post('2203')]);
    const all = await w.polling.claimDueSources(s, new Date(w.clock.now() + 1), 10);
    const bySource = new Map(all.map((c) => [c.externalId, c.sourceId]));
    await w.polling.saveSourcePoll(s, bySource.get('2201')!, {
      nextPollAt: new Date(w.clock.now() - 3000),
    });
    await w.polling.saveSourcePoll(s, bySource.get('2202')!, {
      nextPollAt: new Date(w.clock.now() - 9000),
    });
    await w.polling.saveSourcePoll(s, bySource.get('2203')!, {
      nextPollAt: new Date(w.clock.now() - 6000),
    });
    await w.polling.setOwnerVerified(s, bySource.get('2203')!, false);

    const first = await w.polling.claimDueSources(s, w.now(), 1);
    expect(first.map((c) => c.externalId)).toEqual(['2202']);
    const rest = await w.polling.claimDueSources(s, w.now(), 10);
    expect(rest.map((c) => c.externalId)).toEqual(['2201']);
    expect(await w.polling.claimDueSources(s, w.now(), 10)).toEqual([]);
    const leased = await w.sourcePoll(s, '2202');
    expect(leased!.next_poll_at.getTime()).toBe(w.clock.now() + CLAIM_LEASE_MS);
  });

  it('concurrent claims skip locked rows', async () => {
    const t = await w.tenant('skip');
    const s = await w.insertConnection(t, '1301');
    await w.polling.upsertSources(s, ['2301', '2302', '2303', '2304'].map(post));
    const [x, y] = await Promise.all([
      w.polling.claimDueSources(s, w.now(), 2),
      w.polling.claimDueSources(s, w.now(), 2),
    ]);
    const got = [...x!, ...y!].map((c) => c.externalId);
    expect(new Set(got).size).toBe(got.length);
    expect(got.sort()).toEqual(['2301', '2302', '2303', '2304']);
  });

  it('discovery marks listed posts owner_verified and never clears a stored high-water mark', async () => {
    const t = await w.tenant('disc');
    const s = await w.insertConnection(t, '1401');
    await w.polling.upsertSources(s, [post('2401')]);
    expect((await w.sourcePoll(s, '2401'))!.owner_verified).toBe(true);
    const [c] = await w.polling.claimDueSources(s, w.now(), 1);
    const hw = new Date('2026-10-21T00:00:00Z');
    await w.polling.saveSourcePoll(s, c!.sourceId, { highWaterAt: hw });
    await w.polling.upsertSources(s, [post('2401')]);
    const row = await w.sourcePoll(s, '2401');
    expect(row!.high_water_at).toEqual(hw);
    expect(row!.next_poll_at.getTime()).toBe(w.clock.now() + CLAIM_LEASE_MS);

    const st = await w.polling.discoveryState(s);
    expect(st).toMatchObject({ lastPolledAt: null, lastFullScanAt: null });
    await w.polling.saveDiscovery(s, { lastPolledAt: w.now() });
    expect(await w.polling.discoveryState(s)).toMatchObject({
      lastPolledAt: w.now(),
    });
  });

  it('a post found foreign loses its pending rows and takes no new ones', async () => {
    const t = await w.tenant('foreign');
    const s = await w.insertConnection(t, '1501');
    await wake(s, '2501', '3501');
    await wake(s, '2501', '3502');
    await wake(s, '2502', '3503');
    const claimed = await w.polling.claimDueSources(s, w.now(), 10);
    const foreign = claimed.find((c) => c.externalId === '2501')!;
    expect(foreign.ownerVerified).toBeNull();
    await w.polling.setOwnerVerified(s, foreign.sourceId, false);
    expect((await w.pending(s)).map((p) => p.external_id)).toEqual(['3503']);
    await wake(s, '2501', '3504');
    expect((await w.pending(s)).map((p) => p.external_id)).toEqual(['3503']);
    expect((await w.sourcePoll(s, '2501'))!.owner_verified).toBe(false);
  });

  it('pendingFor lists a source oldest first; bumpPending drops rows at 5 attempts and counts them', async () => {
    const t = await w.tenant('pending');
    const s = await w.insertConnection(t, '1601');
    for (const [i, id] of ['3601', '3602', '3603'].entries())
      await w.polling.recordWake(s, {
        sourceExternalId: '2601',
        replyExternalId: id,
        receivedAt: new Date(w.clock.now() + i),
      });
    await wake(s, '2602', '3604');
    expect(await w.polling.pendingFor(s, '2601', 2)).toEqual([
      { externalId: '3601', attempts: 0 },
      { externalId: '3602', attempts: 0 },
    ]);
    await w.polling.resolvePending(s, ['3601']);
    expect((await w.polling.pendingFor(s, '2601', 10)).map((p) => p.externalId)).toEqual([
      '3602',
      '3603',
    ]);

    for (let i = 0; i < 4; i++) expect(await w.polling.bumpPending(s, ['3602'])).toBe(0);
    expect((await w.polling.pendingFor(s, '2601', 10))[0]).toEqual({
      externalId: '3602',
      attempts: 4,
    });
    expect(await w.polling.bumpPending(s, ['3602', '3603'])).toBe(1);
    expect((await w.pending(s)).map((p) => [p.external_id, p.attempts])).toEqual([
      ['3603', 1],
      ['3604', 0],
    ]);
  });
});
