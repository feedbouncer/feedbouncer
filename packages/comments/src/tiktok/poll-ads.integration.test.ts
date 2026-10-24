import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorError } from '@feedbouncer/connectors';
import { classifyFailure } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { EXECUTE_JOB, TIKTOK_ADS_POLL_JOB, TIKTOK_POLL_JOB } from '../jobs/specs.js';
import { executeActionJob } from '../jobs/execute.js';
import { ModerationActions } from '../actions.js';
import { tiktokAdsPollJob } from './poll-ads.js';
import { tiktokPollJob } from './poll-organic.js';
import { DAY_MS, SETTINGS, log, tiktokWorld, type TikTokWorld } from './test-world.js';

let w: TikTokWorld;
beforeAll(async () => {
  w = await tiktokWorld('ads');
});
afterAll(() => w.close());
beforeEach(() => w.reset());

const deps = () => ({
  runtime: w.runtime,
  polling: w.polling,
  store: w.store,
  clock: w.now,
  settings: SETTINGS,
});
const pollAds = (scope: ConnectionScope) =>
  tiktokAdsPollJob(deps()).handle(w.jobCtx(scope, 'tiktok_ads', TIKTOK_ADS_POLL_JOB.type), {
    connectionId: scope.connectionId,
  });
const pollOrganic = (scope: ConnectionScope) =>
  tiktokPollJob(deps()).handle(w.jobCtx(scope, 'tiktok', TIKTOK_POLL_JOB.type), {
    connectionId: scope.connectionId,
  });

let nextAd = 1_800_000_000_000_000;
const newAd = () => ({ adId: String(nextAd++), itemId: String(nextAd++) });

async function advertiser(label: string) {
  const tenant = await w.tenant(label);
  return { tenant, ...(await w.connectAds(tenant)) };
}
const addAdComments = (
  advertiserId: string,
  ad: { adId: string; itemId: string },
  n: number,
  o: { stepMs: number; offsetMs?: number; parentId?: string },
) =>
  Array.from(
    { length: n },
    (_, i) =>
      w.fake.addAdComment(advertiserId, {
        ...ad,
        text: `a${i}`,
        createdAt: new Date(w.clock.now() - (o.offsetMs ?? 0) - i * o.stepMs),
        ...(o.parentId !== undefined && { parentId: o.parentId }),
      }).commentId,
  );
const adPages = () => w.fake.calls('adCommentList').map((c) => c.query.page);
const storedIds = async (s: ConnectionScope) =>
  new Set((await w.comments(s)).map((r) => r.external_id));

describe('tiktok_ads_poll', () => {
  it('ingests 250 comments across 3 pages with ad sources and flat replies', async () => {
    const { scope, advertiserId } = await advertiser('pages');
    const [a1, a2] = [newAd(), newAd()];
    addAdComments(advertiserId, a1!, 150, { stepMs: 60_000, offsetMs: 60_000 });
    const tops = addAdComments(advertiserId, a2!, 80, { stepMs: 61_000, offsetMs: 90_000 });
    const replies = addAdComments(advertiserId, a2!, 20, {
      stepMs: 1000,
      offsetMs: 30_000,
      parentId: tops[0]!,
    });
    const before = adPages().length;
    await pollAds(scope);
    expect(adPages().length - before).toBe(3);
    const rows = await w.comments(scope);
    expect(rows).toHaveLength(250);
    expect(rows.every((r) => r.source_kind === 'ad_post')).toBe(true);
    const sources = await w.pool.query<{ external_id: string; kind: string }>(
      `SELECT external_id, kind FROM source WHERE organization_id = $1 AND brand_id = $2
          AND connection_id = $3 ORDER BY external_id`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    );
    expect(sources.rows).toEqual([
      { external_id: a1!.adId, kind: 'ad_post' },
      { external_id: a2!.adId, kind: 'ad_post' },
    ]);
    for (const id of replies) {
      const r = rows.find((x) => x.external_id === id)!;
      expect(r).toMatchObject({ parent_external_id: tops[0], source_external_id: a2!.adId });
      expect(r.parent_comment_id).not.toBeNull();
    }
    expect(rows.every((r) => r.ingest_origin === 'backfill')).toBe(true);
    expect(await w.connectionPoll(scope)).toMatchObject({
      pass_started_at: null,
      resume_page: null,
      high_water_at: new Date(w.clock.now() - 30_000 - SETTINGS.adsOverlapSec * 1000),
    });
  });

  it('ads poll survives a delete across a page boundary', async () => {
    const { scope, advertiserId } = await advertiser('boundary');
    const ad = newAd();
    const ids = addAdComments(advertiserId, ad, 250, { stepMs: 1000, offsetMs: 60_000 });
    // Before page 2 is served, a page-1 item disappears: ids[100] moves onto page 1.
    w.fake.mutateBetweenPages(() => w.fake.deleteComment(ids[10]!));
    await pollAds(scope);
    expect((await storedIds(scope)).has(ids[100]!)).toBe(false);

    w.advance(SETTINGS.adsPollIntervalSec * 1000);
    await pollAds(scope);
    const stored = await storedIds(scope);
    for (const id of ids) if (id !== ids[10]) expect(stored.has(id)).toBe(true);
    expect(await w.comments(scope)).toHaveLength(250);
  });

  it('ads poll resumes from resume_page after a throttle', async () => {
    const { scope, advertiserId } = await advertiser('resume');
    addAdComments(advertiserId, newAd(), 500, { stepMs: 1000, offsetMs: 60_000 });
    await pollAds(scope);
    const hw = (await w.connectionPoll(scope))!.high_water_at;
    w.advance(SETTINGS.adsFullScanIntervalSec * 1000);
    addAdComments(advertiserId, newAd(), 10, { stepMs: 1000, offsetMs: 60_000 });

    // Queued while page 2 is served, so page 3 of the full scan is refused.
    w.fake.mutateBetweenPages(() => w.fake.throttleNext('adCommentList', 1));
    const err: unknown = await pollAds(scope).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'rate_limited' });
    expect(await w.connectionPoll(scope)).toMatchObject({ resume_page: 3, high_water_at: hw });

    w.advance(60_000);
    const before = adPages().length;
    await pollAds(scope);
    expect(adPages()[before]).toBe('3');
    expect(await w.comments(scope)).toHaveLength(510);
    const after = await w.connectionPoll(scope);
    expect(after).toMatchObject({ resume_page: null, pass_started_at: null });
    expect(after!.high_water_at!.getTime()).toBeGreaterThan(hw!.getTime());
  });

  it('a pass longer than maxPagesPerJob continues in the next job without moving the high-water mark', async () => {
    const { scope, advertiserId } = await advertiser('pagecap');
    addAdComments(advertiserId, newAd(), 250, { stepMs: 1000, offsetMs: 60_000 });
    const job = tiktokAdsPollJob({ ...deps(), settings: { ...SETTINGS, maxPagesPerJob: 1 } });
    const run = () =>
      job.handle(w.jobCtx(scope, 'tiktok_ads', TIKTOK_ADS_POLL_JOB.type), {
        connectionId: scope.connectionId,
      });
    expect(await run()).toMatchObject({ pages: 1, complete: false });
    expect(await w.connectionPoll(scope)).toMatchObject({ resume_page: 2, high_water_at: null });
    w.advance(1000);
    await run();
    expect(await run()).toMatchObject({ complete: true });
    expect(await w.comments(scope)).toHaveLength(250);
    expect((await w.connectionPoll(scope))!.high_water_at).not.toBeNull();
  });

  it('thirty comments arriving mid-pass are not skipped', async () => {
    const { scope, advertiserId } = await advertiser('midpass');
    const ad = newAd();
    addAdComments(advertiserId, ad, 250, { stepMs: 1000, offsetMs: 60_000 });
    let late: string[] = [];
    w.fake.mutateBetweenPages(() => {
      late = addAdComments(advertiserId, ad, 30, { stepMs: 100 });
    });
    await pollAds(scope);
    expect(late).toHaveLength(30);
    w.advance(SETTINGS.adsPollIntervalSec * 1000);
    await pollAds(scope);
    const stored = await storedIds(scope);
    for (const id of late) expect(stored.has(id)).toBe(true);
    expect(await w.comments(scope)).toHaveLength(280);
  });

  it('full scan refreshes hidden state of comments on ended ads; absent comments keep last state', async () => {
    const { scope, advertiserId } = await advertiser('fullscan');
    const ended = newAd();
    const [hidden, gone] = addAdComments(advertiserId, ended, 2, {
      stepMs: 1000,
      offsetMs: 3 * DAY_MS,
    });
    addAdComments(advertiserId, newAd(), 1, { stepMs: 1000, offsetMs: 60_000 });
    await pollAds(scope);
    const state = async () =>
      Object.fromEntries((await w.comments(scope)).map((r) => [r.external_id, r.platform_state]));
    expect(await state()).toMatchObject({ [hidden!]: 'visible', [gone!]: 'visible' });

    const client = await w.runtime.connect(scope);
    expect(
      await client.act({
        action: 'hide',
        target: { sourceExternalId: ended.adId, externalId: hidden! },
      }),
    ).toMatchObject({ status: 'applied' });
    w.fake.deleteComment(gone!);

    w.advance(SETTINGS.adsPollIntervalSec * 1000);
    await pollAds(scope);
    expect(await state()).toMatchObject({ [hidden!]: 'visible', [gone!]: 'visible' });

    w.advance(SETTINGS.adsFullScanIntervalSec * 1000);
    await pollAds(scope);
    expect(await state()).toMatchObject({ [hidden!]: 'hidden', [gone!]: 'visible' });
    expect((await w.connectionPoll(scope))!.last_full_scan_at).toEqual(w.now());
  });

  it('two advertisers in one brand attribute comments to their own connection', async () => {
    const tenant = await w.tenant('two');
    const one = await w.connectAds(tenant);
    const two = await w.connectAds(tenant);
    const ad1 = newAd();
    const ad2 = newAd();
    const c1 = addAdComments(one.advertiserId, ad1, 3, { stepMs: 1000, offsetMs: 60_000 });
    const c2 = addAdComments(two.advertiserId, ad2, 2, { stepMs: 1000, offsetMs: 60_000 });
    await pollAds(one.scope);
    await pollAds(two.scope);
    expect([...(await storedIds(one.scope))].sort()).toEqual([...c1].sort());
    expect([...(await storedIds(two.scope))].sort()).toEqual([...c2].sort());
    expect((await w.comments(one.scope)).every((r) => r.source_external_id === ad1.adId)).toBe(
      true,
    );
    expect((await w.comments(two.scope)).every((r) => r.source_external_id === ad2.adId)).toBe(
      true,
    );
  });

  it('spark ad comment stays separate per connection', async () => {
    const tenant = await w.tenant('spark');
    const organic = await w.connectTikTok(tenant);
    const ads = await w.connectAds(tenant);
    const { itemId } = w.fake.addVideo(organic.businessId);
    const p1 = w.fake.addComment(itemId, {
      text: 'p1',
      createdAtSec: Math.floor(w.clock.now() / 1000) - 120,
    });
    const x = w.fake.addComment(itemId, {
      text: 'x organic',
      parentId: p1.commentId,
      createdAtSec: Math.floor(w.clock.now() / 1000) - 60,
    }).commentId;
    const ad = { adId: String(nextAd++), itemId };
    const [p2] = addAdComments(ads.advertiserId, ad, 1, { stepMs: 1000, offsetMs: 120_000 });
    w.fake.addAdComment(ads.advertiserId, {
      ...ad,
      commentId: x,
      parentId: p2!,
      text: 'x ad',
      createdAt: new Date(w.clock.now() - 60_000),
    });
    await pollOrganic(organic.scope);
    await pollAds(ads.scope);

    const rows = await w.pool.query<{
      connection_id: string;
      parent_connection_id: string;
      parent_external_id: string;
      id: string;
    }>(
      `SELECT c.id, c.connection_id, p.connection_id AS parent_connection_id, p.external_id AS parent_external_id
         FROM comment c JOIN comment p ON p.id = c.parent_comment_id AND p.organization_id = c.organization_id
        WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.external_id = $3
        ORDER BY c.connection_id`,
      [tenant.organizationId, tenant.brandId, x],
    );
    expect(rows.rows).toHaveLength(2);
    const byConn = new Map(rows.rows.map((r) => [r.connection_id, r]));
    expect(byConn.get(organic.scope.connectionId)).toMatchObject({
      parent_connection_id: organic.scope.connectionId,
      parent_external_id: p1.commentId,
    });
    expect(byConn.get(ads.scope.connectionId)).toMatchObject({
      parent_connection_id: ads.scope.connectionId,
      parent_external_id: p2,
    });

    const producer = {
      enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
    };
    const actions = new ModerationActions({
      pool: w.pool,
      store: w.store,
      producer,
      capabilities: (p) => w.registry.get(p)?.capabilities,
      clock: w.clock,
      log,
    });
    const r = await actions.request({
      scope: organic.scope,
      commentId: byConn.get(organic.scope.connectionId)!.id,
      kind: 'hide',
      actor: { type: 'user', userId: tenant.userId },
      requestKey: `rk-${randomUUID()}`,
    });
    if (r.status !== 'accepted') throw new Error(`expected accepted, got ${r.status}`);
    const hides = w.fake.calls('businessCommentHide').length;
    const adUpdates = w.fake.calls('adCommentStatusUpdate').length;
    await executeActionJob({
      pool: w.pool,
      runtime: w.runtime,
      log,
      producer,
      clock: w.clock,
    }).handle(w.jobCtx(organic.scope, 'tiktok', EXECUTE_JOB.type), { actionId: r.action.id });
    expect(w.fake.calls('businessCommentHide').length - hides).toBe(1);
    expect(w.fake.calls('adCommentStatusUpdate').length - adUpdates).toBe(0);
  });

  it('marketing outage fails the ads job transiently while the organic job for the same brand succeeds', async () => {
    const tenant = await w.tenant('outage');
    const organic = await w.connectTikTok(tenant);
    const ads = await w.connectAds(tenant);
    const { itemId } = w.fake.addVideo(organic.businessId);
    w.fake.addComment(itemId, { text: 'ok', createdAtSec: Math.floor(w.clock.now() / 1000) - 60 });
    addAdComments(ads.advertiserId, newAd(), 1, { stepMs: 1000, offsetMs: 60_000 });
    w.fake.outage('marketing', true);
    try {
      const err: unknown = await pollAds(ads.scope).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect(classifyFailure(err)).toMatchObject({ kind: 'retryable' });
      await expect(pollOrganic(organic.scope)).resolves.toMatchObject({ created: 1 });
    } finally {
      w.fake.outage('marketing', false);
    }
    expect(await w.connectionRow(ads.scope)).toMatchObject({ status: 'active' });
    expect(await w.connectionRow(organic.scope)).toMatchObject({ status: 'active' });
    expect(await w.comments(ads.scope)).toHaveLength(0);
    await pollAds(ads.scope);
    expect(await w.comments(ads.scope)).toHaveLength(1);
  });
});
