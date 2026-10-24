import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyFailure } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { TIKTOK_POLL_JOB } from '../jobs/specs.js';
import { tiktokPollJob } from './poll-organic.js';
import type { TikTokPollSettings } from './ingest.js';
import { DAY_MS, SETTINGS, secAgo, tiktokWorld, type TikTokWorld } from './test-world.js';

let w: TikTokWorld;
beforeAll(async () => {
  w = await tiktokWorld('organic');
});
afterAll(() => w.close());
beforeEach(() => w.reset());

type OrganicResult = {
  videos: number;
  done: number;
  resumed: number;
  unavailable: number;
  created: number;
  updated: number;
};

const poll = async (scope: ConnectionScope, settings: TikTokPollSettings = SETTINGS) =>
  (await tiktokPollJob({
    runtime: w.runtime,
    polling: w.polling,
    store: w.store,
    clock: w.now,
    settings,
  }).handle(w.jobCtx(scope, 'tiktok', TIKTOK_POLL_JOB.type), {
    connectionId: scope.connectionId,
  })) as OrganicResult;

async function account(label: string) {
  const a = await w.tenant(label);
  return { tenant: a, ...(await w.connectTikTok(a)) };
}
const addComments = (itemId: string, n: number, o: { stepMs: number; offsetMs?: number }) =>
  Array.from(
    { length: n },
    (_, i) =>
      w.fake.addComment(itemId, {
        text: `c${i}`,
        createdAtSec: secAgo(w, (o.offsetMs ?? 0) + i * o.stepMs),
      }).commentId,
  );
const listCalls = (itemId: string) =>
  w.fake.calls('businessCommentList').filter((c) => c.query.video_id === itemId);

describe('tiktok_poll', () => {
  it('first pass backfills 30 days, caps at 2000, marks origin backfill', async () => {
    const { scope, businessId } = await account('backfill');
    for (let v = 0; v < 3; v++) {
      const { itemId } = w.fake.addVideo(businessId);
      addComments(itemId, 900, { stepMs: 2_500_000 });
      addComments(itemId, 5, { stepMs: 1000, offsetMs: 31 * DAY_MS });
    }
    await poll(scope);
    const rows = await w.comments(scope);
    expect(rows).toHaveLength(2000);
    expect(rows.every((r) => r.ingest_origin === 'backfill')).toBe(true);
    expect(rows.every((r) => r.posted_at.getTime() >= w.clock.now() - 30 * DAY_MS)).toBe(true);
    expect(rows.every((r) => r.source_kind === 'video')).toBe(true);

    // The cap holds for the rest of the connection; new comments are live.
    w.advance(SETTINGS.pollIntervalSec * 1000);
    const [video] = rows;
    const fresh = w.fake.addComment(video!.source_external_id, {
      text: 'new',
      createdAtSec: secAgo(w, 0),
    }).commentId;
    await poll(scope);
    const after = await w.comments(scope);
    expect(after).toHaveLength(2001);
    expect(after.find((r) => r.external_id === fresh)).toMatchObject({ ingest_origin: 'live' });
  });

  it('second pass ingests only new comments; re-running the same bucket creates no duplicates', async () => {
    const { scope, businessId } = await account('second');
    const { itemId } = w.fake.addVideo(businessId);
    addComments(itemId, 50, { stepMs: 60_000, offsetMs: 60_000 });
    expect(await poll(scope)).toMatchObject({ videos: 1, done: 1, created: 50 });

    w.advance(SETTINGS.pollIntervalSec * 1000);
    const fresh = addComments(itemId, 3, { stepMs: 1000 });
    const before = listCalls(itemId).length;
    expect(await poll(scope)).toMatchObject({ done: 1, created: 3 });
    expect(listCalls(itemId).length - before).toBe(1);
    const rows = await w.comments(scope);
    expect(rows).toHaveLength(53);
    for (const id of fresh)
      expect(rows.find((r) => r.external_id === id)).toMatchObject({ ingest_origin: 'live' });

    await poll(scope);
    expect(await w.comments(scope)).toHaveLength(53);
    // Even a forced re-read of the same window stores nothing twice.
    await w.pool.query(
      `UPDATE source_poll SET next_poll_at = $4, high_water_at = NULL
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [scope.organizationId, scope.brandId, scope.connectionId, w.now()],
    );
    await poll(scope);
    expect(await w.comments(scope)).toHaveLength(53);
  });

  it('replies to comments read in the pass are ingested with parents', async () => {
    const { scope, businessId } = await account('replies');
    const { itemId } = w.fake.addVideo(businessId);
    const [withReplies, without] = addComments(itemId, 2, { stepMs: 60_000, offsetMs: 600_000 });
    const replies = [1, 2, 3].map(
      (i) =>
        w.fake.addComment(itemId, {
          text: `r${i}`,
          parentId: withReplies!,
          createdAtSec: secAgo(w, i * 1000),
        }).commentId,
    );
    await poll(scope);
    const rows = await w.comments(scope);
    expect(rows).toHaveLength(5);
    const parentRow = await w.pool.query<{ id: string }>(
      'SELECT id FROM comment WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND external_id = $4',
      [scope.organizationId, scope.brandId, scope.connectionId, withReplies],
    );
    for (const id of replies)
      expect(rows.find((r) => r.external_id === id)).toMatchObject({
        parent_external_id: withReplies,
        parent_comment_id: parentRow.rows[0]!.id,
      });
    const replyCalls = w.fake.calls('businessReplyList').map((c) => c.query.comment_id);
    expect(replyCalls).toContain(withReplies);
    expect(replyCalls).not.toContain(without);
  });

  it('a late reply to an old comment arrives on the deep scan', async () => {
    const { scope, businessId } = await account('deep');
    const { itemId } = w.fake.addVideo(businessId);
    const old = w.fake.addComment(itemId, { text: 'old', createdAtSec: secAgo(w, 10 * DAY_MS) });
    addComments(itemId, 40, { stepMs: 1000, offsetMs: 3_600_000 });
    await poll(scope);
    expect(await w.comments(scope)).toHaveLength(41);

    w.advance(SETTINGS.pollIntervalSec * 1000);
    const late = w.fake.addComment(itemId, {
      text: 'late',
      parentId: old.commentId,
      createdAtSec: secAgo(w, 0),
    }).commentId;
    await poll(scope);
    expect((await w.comments(scope)).map((r) => r.external_id)).not.toContain(late);

    w.advance(SETTINGS.deepScanIntervalSec * 1000);
    await poll(scope);
    expect((await w.comments(scope)).find((r) => r.external_id === late)).toMatchObject({
      parent_external_id: old.commentId,
      ingest_origin: 'live',
    });
  });

  it('permission error on one video marks only that source unavailable', async () => {
    const { scope, businessId } = await account('perm');
    const videos = [0, 1, 2].map(() => w.fake.addVideo(businessId).itemId);
    for (const v of videos) addComments(v, 2, { stepMs: 1000, offsetMs: 60_000 });
    w.fake.failNext('businessCommentList', { code: 40001 });
    expect(await poll(scope)).toMatchObject({ videos: 3, done: 2, unavailable: 1 });
    expect(await w.connectionRow(scope)).toMatchObject({ status: 'active' });
    const states = await Promise.all(videos.map((v) => w.sourcePoll(scope, v)));
    const bad = states.filter((s) => s?.last_error_code !== null);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({
      last_error_code: 'source_inaccessible',
      unavailable_since: w.now(),
      next_poll_at: new Date(w.clock.now() + SETTINGS.sourceUnavailableRetrySec * 1000),
    });
    expect(await w.comments(scope)).toHaveLength(4);
  });

  it('scope missing on the video list marks reconnect_required/oauth_scope_missing with video.list and keeps stored comments', async () => {
    const { scope, businessId } = await account('scope');
    const { itemId } = w.fake.addVideo(businessId);
    addComments(itemId, 3, { stepMs: 1000, offsetMs: 60_000 });
    await poll(scope);
    expect(await w.comments(scope)).toHaveLength(3);

    w.advance(SETTINGS.videoDiscoveryIntervalSec * 1000);
    w.fake.revokeScope(businessId, 'businessVideoList');
    const err: unknown = await poll(scope).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'needs_reconnection' });
    expect(await w.connectionRow(scope)).toEqual({
      status: 'reconnect_required',
      status_reason: 'oauth_scope_missing',
      missing_scopes: ['video.list'],
    });
    expect(await w.comments(scope)).toHaveLength(3);
  });

  it('throttle mid-video resumes from the saved cursor', async () => {
    const { scope, businessId } = await account('throttle');
    const { itemId } = w.fake.addVideo(businessId);
    addComments(itemId, 100, { stepMs: 1000, offsetMs: 60_000 });
    // Queued while page 2 is served, so page 3 is refused.
    w.fake.mutateBetweenPages(() => w.fake.throttleNext('businessCommentList', 1));
    const err: unknown = await poll(scope).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'rate_limited' });
    expect(await w.comments(scope)).toHaveLength(60);
    expect(await w.sourcePoll(scope, itemId)).toMatchObject({
      resume_cursor: '60',
      high_water_at: null,
    });

    w.advance(60_000);
    const before = listCalls(itemId).length;
    expect(await poll(scope)).toMatchObject({ done: 1 });
    expect(listCalls(itemId)[before]?.query.cursor).toBe('60');
    expect(await w.comments(scope)).toHaveLength(100);
    expect(await w.sourcePoll(scope, itemId)).toMatchObject({ resume_cursor: null });
  });

  it('a newly listed video keeps comments older than the local end of the backfill', async () => {
    const { scope, businessId } = await account('newvideo');
    const { itemId: first } = w.fake.addVideo(businessId);
    addComments(first, 1, { stepMs: 1000, offsetMs: 60_000 });
    await poll(scope);
    expect((await w.connectionPoll(scope))!.high_water_at).toBeNull();

    w.advance(SETTINGS.videoDiscoveryIntervalSec * 1000);
    const { itemId: later } = w.fake.addVideo(businessId);
    const [early] = addComments(later, 1, { stepMs: 1000, offsetMs: 3_600_000 });
    await poll(scope);
    expect((await w.comments(scope)).find((r) => r.external_id === early)).toMatchObject({
      source_external_id: later,
      ingest_origin: 'live',
    });
  });

  it('an empty first pass records the scan but no high-water mark', async () => {
    const { scope, businessId } = await account('empty');
    const { itemId } = w.fake.addVideo(businessId);
    await poll(scope);
    expect(await w.sourcePoll(scope, itemId)).toMatchObject({ high_water_at: null });
    const scanned = await w.pool.query<{ last_full_scan_at: Date | null }>(
      `SELECT sp.last_full_scan_at FROM source_poll sp JOIN source s ON s.id = sp.source_id
        WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3 AND s.external_id = $4`,
      [scope.organizationId, scope.brandId, scope.connectionId, itemId],
    );
    expect(scanned.rows[0]!.last_full_scan_at).toEqual(w.now());

    // A video without comments polls at the quiet interval.
    w.advance(SETTINGS.quietVideoPollIntervalSec * 1000);
    const [c] = addComments(itemId, 1, { stepMs: 1000, offsetMs: 0 });
    await poll(scope);
    expect((await w.comments(scope)).find((r) => r.external_id === c)).toMatchObject({
      ingest_origin: 'live',
    });
    expect((await w.sourcePoll(scope, itemId))!.high_water_at).toEqual(
      new Date(Math.floor(w.clock.now() / 1000) * 1000),
    );
  });

  it('a recently posted video without comments polls at the active interval, an old one at the quiet interval', async () => {
    const { scope, businessId } = await account('posted');
    const { itemId: fresh } = w.fake.addVideo(businessId, { createdAtSec: secAgo(w, DAY_MS) });
    const { itemId: old } = w.fake.addVideo(businessId, { createdAtSec: secAgo(w, 60 * DAY_MS) });
    await poll(scope);
    const at = (s: number) => new Date(w.clock.now() + s * 1000);
    expect((await w.sourcePoll(scope, fresh))!.next_poll_at).toEqual(at(SETTINGS.pollIntervalSec));
    expect((await w.sourcePoll(scope, old))!.next_poll_at).toEqual(
      at(SETTINGS.quietVideoPollIntervalSec),
    );

    // A comment on the fresh video arrives one poll interval later, as a live comment.
    const [c] = addComments(fresh, 1, { stepMs: 1000, offsetMs: 0 });
    w.advance(SETTINGS.pollIntervalSec * 1000);
    await poll(scope);
    expect((await w.comments(scope)).find((r) => r.external_id === c)).toMatchObject({
      ingest_origin: 'live',
    });
  });

  it('a pass longer than maxPagesPerJob continues in the next job', async () => {
    const { scope, businessId } = await account('pages');
    const { itemId } = w.fake.addVideo(businessId);
    addComments(itemId, 100, { stepMs: 1000, offsetMs: 60_000 });
    const short = { ...SETTINGS, maxPagesPerJob: 2 };
    expect(await poll(scope, short)).toMatchObject({ resumed: 1 });
    expect(await w.sourcePoll(scope, itemId)).toMatchObject({ resume_cursor: '30' });
    let jobs = 1;
    while ((await poll(scope, short)).resumed > 0 && jobs < 10) jobs++;
    expect(jobs).toBe(2);
    expect(await w.comments(scope)).toHaveLength(100);
    expect(await w.sourcePoll(scope, itemId)).toMatchObject({ resume_cursor: null });
  });

  it('a comment deleted on TikTok after ingest becomes deleted on the next pass via platformState, never resurrected', async () => {
    const { scope, businessId } = await account('deleted');
    const { itemId } = w.fake.addVideo(businessId);
    const [gone, kept] = addComments(itemId, 2, { stepMs: 1000, offsetMs: 60_000 });
    await poll(scope);
    expect((await w.comments(scope)).map((r) => r.platform_state)).toEqual(['visible', 'visible']);

    w.setTamper((path, data) =>
      path.includes('business/comment/list') && Array.isArray(data.comments)
        ? {
            ...data,
            comments: (data.comments as { comment_id: string }[]).map((c) =>
              c.comment_id === gone ? { ...c, status: 'DELETED' } : c,
            ),
          }
        : data,
    );
    try {
      w.advance(SETTINGS.pollIntervalSec * 1000);
      await poll(scope);
    } finally {
      w.setTamper(null);
    }
    const state = async () =>
      Object.fromEntries((await w.comments(scope)).map((r) => [r.external_id, r.platform_state]));
    expect(await state()).toEqual({ [gone!]: 'deleted', [kept!]: 'visible' });

    // TikTok lists it as visible again: the stored copy stays deleted.
    w.advance(SETTINGS.deepScanIntervalSec * 1000);
    await poll(scope);
    expect(await state()).toEqual({ [gone!]: 'deleted', [kept!]: 'visible' });
  });
});
