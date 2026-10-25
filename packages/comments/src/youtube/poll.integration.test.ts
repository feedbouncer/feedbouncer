// The channel poller over the real connector runtime, the Pg quota ledger and FakeYouTube.
// The fake's one channel is shared by every connection in this file, so assertions look at
// this test's own videos and at call deltas.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commentFingerprint } from '@feedbouncer/db';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { pollChannel, type PollDeps, type PollState } from './poll.js';
import { CHANNEL, youtubeWorld, type YouTubeWorld } from './test-world.js';

let w: YouTubeWorld;
beforeAll(async () => {
  w = await youtubeWorld('poll');
});
afterAll(() => w.close());
beforeEach(async () => {
  w.reset();
  await w.clearPause();
});

const FRESH: PollState = { ownerChannelId: CHANNEL, highWaterAt: null, resumePageToken: null };
const BIG = 1000;

const deps = async (scope: ConnectionScope): Promise<PollDeps> => ({
  pool: w.pool,
  client: await w.runtime.connect(scope),
  store: w.store,
  applied: w.applied,
  clock: () => w.now(),
  log: w.log,
});
const poll = async (scope: ConnectionScope, s: PollState = FRESH, allowance = BIG) =>
  pollChannel(await deps(scope), scope, s, allowance);
const stored = async (scope: ConnectionScope, videoId: string) =>
  (await w.comments(scope)).filter((c) => c.source_external_id === videoId);
const hooked = () => w.applied.onApplied.mock.calls.map((c) => (c[0] as { body: string }).body);
const feedCalls = (from: number) =>
  w.callsSince(from, 'commentThreads.list').filter((c) => c.query['id'] === undefined);

describe('pollChannel', () => {
  it('ingests new threads and replies and hands them to the rule hook', async () => {
    const c = await w.connect('ingest');
    const top = w.fake.addComment({ videoId: c.videoId, text: 'ingest top' });
    w.fake.addComment({ parentId: top, text: 'ingest reply' });

    const r = await poll(c.scope);

    const rows = await stored(c.scope, c.videoId);
    expect(rows.map((x) => [x.body, x.parent_external_id])).toEqual([
      ['ingest top', null],
      ['ingest reply', top],
    ]);
    expect(rows.every((x) => x.source_kind === 'video')).toBe(true);
    expect(hooked()).toEqual(expect.arrayContaining(['ingest top', 'ingest reply']));
    expect(w.applied.onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'youtube', outcome: 'created' }),
    );
    expect(r.ingested).toBeGreaterThanOrEqual(2);
    expect(r.readUnits).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent across two polls', async () => {
    const c = await w.connect('idem');
    const top = w.fake.addComment({ videoId: c.videoId, text: 'idem top' });
    w.fake.addComment({ parentId: top, text: 'idem reply' });
    await poll(c.scope);
    const before = (await w.comments(c.scope)).length;
    w.applied.onApplied.mockClear();
    w.advance(300_000);

    await poll(c.scope);

    expect((await w.comments(c.scope)).length).toBe(before);
    expect(hooked()).toEqual([]);
  });

  it('reply sweep fetches only threads whose count rose', async () => {
    const c = await w.connect('sweep');
    const a = w.fake.addComment({ videoId: c.videoId, text: 'sweep a' });
    const b = w.fake.addComment({ videoId: c.videoId, text: 'sweep b' });
    for (let i = 0; i < 6; i++) {
      w.fake.addComment({ parentId: a, text: `a${i}` });
      w.fake.addComment({ parentId: b, text: `b${i}` });
    }
    // Google inlines only five replies, so the first poll finds one missing in each thread.
    await poll(c.scope);
    expect((await stored(c.scope, c.videoId)).filter((x) => x.body.startsWith('a'))).toHaveLength(
      6,
    );
    w.advance(300_000);
    w.fake.addComment({ parentId: a, text: 'a6' });
    const from = w.fake.calls.length;

    await poll(c.scope);

    const sweeps = w.callsSince(from, 'commentThreads.list').filter((x) => x.query['id']);
    const replies = w.callsSince(from, 'comments.list');
    expect(sweeps).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.query['parentId']).toBe(a);
    expect((await stored(c.scope, c.videoId)).filter((x) => x.body.startsWith('a'))).toHaveLength(
      7,
    );
  });

  it('commentsDisabled on one video does not fail the poll', async () => {
    const c = await w.connect('disabled');
    const top = w.fake.addComment({ videoId: c.videoId, text: 'disabled top' });
    for (let i = 0; i < 6; i++) w.fake.addComment({ parentId: top, text: `d${i}` });
    const other = w.fake.addVideo();
    w.fake.addComment({ videoId: other, text: 'other video' });
    w.fake.failOn('comments.list', 'commentsDisabled', 403);

    await expect(poll(c.scope)).resolves.toBeDefined();

    const rows = await w.comments(c.scope);
    expect(rows.find((x) => x.body === 'other video')).toBeDefined();
    expect(rows.find((x) => x.body === 'disabled top')!.source_active).toBe(false);
    expect(rows.find((x) => x.body === 'other video')!.source_active).toBe(true);
    expect(w.lines.some((l) => l.msg === 'youtube.source_unavailable')).toBe(true);
  });

  it('stops paging at the high-water mark', async () => {
    const c = await w.connect('hwm');
    const video = w.fake.addVideo();
    const t = w.clock.now();
    for (let i = 0; i < 250; i++)
      w.fake.addComment({
        videoId: video,
        text: `old ${i}`,
        publishedAt: new Date(t - 3 * 3_600_000 - i * 1000),
      });
    w.fake.addComment({ videoId: video, text: 'fresh', publishedAt: new Date(t - 60_000) });
    const from = w.fake.calls.length;

    const r = await poll(c.scope, {
      ...FRESH,
      highWaterAt: new Date(t - 3_600_000),
    });

    expect(feedCalls(from)).toHaveLength(1);
    expect(r.resumePageToken).toBeNull();
    expect(r.newHighWaterAt!.getTime()).toBeGreaterThanOrEqual(t - 60_000);
    expect(hooked()).toContain('fresh');
  });

  it('keeps its place when the allowance runs out and continues from it', async () => {
    const c = await w.connect('resume');
    const video = w.fake.addVideo();
    const t = w.clock.now();
    for (let i = 0; i < 150; i++)
      w.fake.addComment({
        videoId: video,
        text: `page ${i}`,
        publishedAt: new Date(t - 1000 - i * 1000),
      });

    const first = await poll(c.scope, FRESH, 1);

    expect(first.readUnits).toBe(1);
    expect(first.resumePageToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.newHighWaterAt).toBeNull();
    expect((await stored(c.scope, video)).length).toBeLessThan(150);

    const from = w.fake.calls.length;
    const second = await poll(c.scope, { ...FRESH, resumePageToken: first.resumePageToken });
    expect(feedCalls(from)[0]!.query['pageToken']).toBe(first.resumePageToken);
    expect(second.resumePageToken).toBeNull();
    expect(second.newHighWaterAt).not.toBeNull();
    expect((await stored(c.scope, video)).length).toBeGreaterThan(100);
  });

  it('stops quietly when the quota budget refuses a read', async () => {
    const c = await w.connect('refused');
    await w.settings.update(c.scope, { dailyBudgetUnits: 1 }, c.userId);
    w.fake.addComment({ videoId: c.videoId, text: 'refused top' });

    const r = await poll(c.scope);

    expect(r.readUnits).toBeLessThanOrEqual(1);
  });

  it('does not track the thread of an erased comment', async () => {
    const c = await w.connect('erased');
    const top = w.fake.addComment({ videoId: c.videoId, text: 'erased top' });
    await w.pool.query('INSERT INTO erased_comment (connection_id, fingerprint) VALUES ($1, $2)', [
      c.scope.connectionId,
      commentFingerprint(c.scope.connectionId, top),
    ]);

    await poll(c.scope);

    expect(await stored(c.scope, c.videoId)).toEqual([]);
    const { rowCount } = await w.pool.query(
      'SELECT 1 FROM youtube_thread WHERE connection_id = $1 AND thread_external_id = $2',
      [c.scope.connectionId, top],
    );
    expect(rowCount).toBe(0);
  });

  it('does not re-process held comments', async () => {
    const c = await w.connect('held');
    w.fake.addComment({ videoId: c.videoId, text: 'held body', status: 'heldForReview' });
    w.fake.addComment({ videoId: c.videoId, text: 'published body' });

    await poll(c.scope);

    expect((await stored(c.scope, c.videoId)).map((x) => x.body)).toEqual(['published body']);
    expect(hooked()).not.toContain('held body');
  });
});
