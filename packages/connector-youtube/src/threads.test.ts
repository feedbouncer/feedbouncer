import { describe, expect, it } from 'vitest';
import { ConnectorError } from '@feedbouncer/connectors';
import { listChannelThreads, probeThreadReplyCounts } from './threads.js';
import { CHANNEL, world } from './test-world.js';

const VIEWER = 'UC' + 'v'.repeat(22);
type Json = Record<string, unknown>;
type ThreadJson = { snippet: Json & { topLevelComment: { snippet: Json } } };

describe('listChannelThreads', () => {
  it('normalizes threads and inline replies with plain text', async () => {
    const w = world();
    const top = w.fake.addComment({
      videoId: w.videoId,
      authorChannelId: VIEWER,
      text: '<script>alert(1)</script>',
    });
    const reply = w.fake.addComment({ parentId: top, authorChannelId: CHANNEL, text: 'thanks' });

    const page = await listChannelThreads(w.ctx, { cursor: null });

    expect(w.apiCalls()).toEqual([
      {
        method: 'commentThreads.list',
        units: 1,
        query: {
          allThreadsRelatedToChannelId: CHANNEL,
          part: 'snippet,replies',
          order: 'time',
          maxResults: '100',
          textFormat: 'plainText',
        },
      },
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    const t = page.items[0]!;
    expect(t).toMatchObject({ threadExternalId: top, videoExternalId: w.videoId, replyCount: 1 });
    expect(t.lastActivityAt).toBeInstanceOf(Date);
    expect(t.topLevel).toEqual({
      externalId: top,
      sourceExternalId: w.videoId,
      parentExternalId: null,
      author: { externalId: VIEWER, displayName: 'Viewer', profileUrl: null },
      body: '<script>alert(1)</script>',
      postedAt: expect.any(Date),
      platformState: 'visible',
      permalink: `https://www.youtube.com/watch?v=${w.videoId}&lc=${top}`,
      replyCount: 1,
    });
    expect(t.replies).toEqual([
      expect.objectContaining({
        externalId: reply,
        sourceExternalId: w.videoId,
        parentExternalId: top,
        author: { externalId: CHANNEL, displayName: 'Viewer', profileUrl: null },
        body: 'thanks',
        permalink: `https://www.youtube.com/watch?v=${w.videoId}&lc=${encodeURIComponent(reply)}`,
      }),
    ]);
  });

  it('truncates a 50 KB body to 10000 code points', async () => {
    const w = world();
    w.fake.addComment({ videoId: w.videoId, text: '😀'.repeat(25_000) });
    const page = await listChannelThreads(w.ctx, { cursor: null });
    const body = page.items[0]!.topLevel.body;
    expect([...body]).toHaveLength(10_000);
    expect(body).toBe('😀'.repeat(10_000));
  });

  it('prefers textOriginal over textDisplay', async () => {
    const w = world();
    w.fake.addComment({ videoId: w.videoId, text: 'plain' });
    w.tamper('/commentThreads', (json) => {
      for (const t of json['items'] as ThreadJson[]) {
        t.snippet.topLevelComment.snippet['textDisplay'] = '<b>html</b>';
      }
      return json;
    });
    const page = await listChannelThreads(w.ctx, { cursor: null });
    expect(page.items[0]!.topLevel.body).toBe('plain');
  });

  it('falls back to plain-text textDisplay when textOriginal is absent, kept literal', async () => {
    const w = world();
    w.fake.addComment({ videoId: w.videoId, text: 'ignored' });
    w.tamper('/commentThreads', (json) => {
      for (const t of json['items'] as ThreadJson[]) {
        delete t.snippet.topLevelComment.snippet['textOriginal'];
        t.snippet.topLevelComment.snippet['textDisplay'] = '<b>bold</b> ' + '😀'.repeat(20_000);
      }
      return json;
    });
    const page = await listChannelThreads(w.ctx, { cursor: null });
    const body = page.items[0]!.topLevel.body;
    expect(body.startsWith('<b>bold</b> ')).toBe(true);
    expect([...body]).toHaveLength(10_000);
  });

  it('drops a thread with a malformed video id and counts it', async () => {
    const w = world();
    const bad = w.fake.addComment({ videoId: w.videoId, text: 'a' });
    const good = w.fake.addComment({ videoId: w.videoId, text: 'b' });
    w.tamper('/commentThreads', (json) => {
      for (const t of json['items'] as (ThreadJson & { id: string })[]) {
        if (t.id === bad) {
          t.snippet['videoId'] = '../../x&y=1';
          t.snippet.topLevelComment.snippet['videoId'] = '../../x&y=1';
        }
      }
      return json;
    });
    const page = await listChannelThreads(w.ctx, { cursor: null });
    expect(page.items.map((t) => t.threadExternalId)).toEqual([good]);
    expect(page.dropped).toBe(1);
  });

  it('drops an author id that fails CHANNEL_ID and never stores profile urls', async () => {
    const w = world();
    w.fake.addComment({ videoId: w.videoId, authorChannelId: VIEWER, text: 'a' });
    w.tamper('/commentThreads', (json) => {
      for (const t of json['items'] as ThreadJson[]) {
        Object.assign(t.snippet.topLevelComment.snippet, {
          authorChannelId: { value: 'UC/../evil' },
          authorChannelUrl: 'https://evil.test/',
          authorProfileImageUrl: 'https://evil.test/a.png',
        });
      }
      return json;
    });
    const page = await listChannelThreads(w.ctx, { cursor: null });
    expect(page.items[0]!.topLevel.author).toBeNull();
    expect(JSON.stringify(page)).not.toContain('evil.test');
  });

  it('pages with a validated cursor and refuses a hostile nextPageToken', async () => {
    const w = world();
    for (let i = 0; i < 101; i++) w.fake.addComment({ videoId: w.videoId, text: `c${i}` });
    const first = await listChannelThreads(w.ctx, { cursor: null });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBe('p100');
    const second = await listChannelThreads(w.ctx, { cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(w.apiCalls()[1]!.query['pageToken']).toBe('p100');

    await expect(listChannelThreads(w.ctx, { cursor: 'p1?x=1&y' })).rejects.toMatchObject({
      kind: 'permanent',
      code: 'invalid_platform_id',
    });
    expect(w.apiCalls()).toHaveLength(2);

    w.tamper('/commentThreads', (json) => ({ ...json, nextPageToken: 'p1?a=b' }));
    await expect(listChannelThreads(w.ctx, { cursor: null })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });

  it('held reply maps to platformState hidden', async () => {
    const w = world();
    const top = w.fake.addComment({ videoId: w.videoId, text: 'top' });
    w.fake.addComment({ parentId: top, text: 'held', status: 'heldForReview' });
    w.tamper('/commentThreads', (json) => {
      // The published feed omits held replies; inject one as Google would for the owner.
      const t = (json['items'] as (ThreadJson & { replies?: { comments: unknown[] } })[])[0]!;
      t.replies = {
        comments: [
          {
            kind: 'youtube#comment',
            id: `${top}.held000000001`,
            snippet: {
              videoId: w.videoId,
              parentId: top,
              textOriginal: 'held',
              moderationStatus: 'heldForReview',
              publishedAt: '2026-10-24T09:00:00Z',
              updatedAt: '2026-10-24T09:00:00Z',
            },
          },
        ],
      };
      return json;
    });
    const page = await listChannelThreads(w.ctx, { cursor: null });
    expect(page.items[0]!.replies[0]).toMatchObject({ body: 'held', platformState: 'hidden' });
  });
});

describe('probeThreadReplyCounts', () => {
  it('probeThreadReplyCounts costs exactly 1 unit for 50 threads', async () => {
    const w = world();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(w.fake.addComment({ videoId: w.videoId, text: `t${i}` }));
    w.fake.addComment({ parentId: ids[0]!, text: 'r1' });
    w.fake.addComment({ parentId: ids[0]!, text: 'r2' });

    const counts = await probeThreadReplyCounts(w.ctx, ids);

    expect(w.apiCalls().reduce((s, c) => s + c.units, 0)).toBe(1);
    expect(w.apiCalls()[0]).toMatchObject({
      method: 'commentThreads.list',
      query: { id: ids.join(','), part: 'snippet' },
    });
    expect(counts.size).toBe(50);
    expect(counts.get(ids[0]!)).toBe(2);
    expect(counts.get(ids[1]!)).toBe(0);
  });

  it('refuses more than 50 threads or a malformed id before any call', async () => {
    const w = world();
    const many = Array.from({ length: 51 }, (_, i) => `Ugz${String(i).padStart(12, '0')}`);
    await expect(probeThreadReplyCounts(w.ctx, many)).rejects.toMatchObject({
      code: 'batch_too_large',
    });
    await expect(probeThreadReplyCounts(w.ctx, ['Ugz000000000001,x'])).rejects.toMatchObject({
      code: 'invalid_platform_id',
    });
    expect(w.apiCalls()).toHaveLength(0);
  });
});

describe('connector reads', () => {
  it('listComments(parentId) pages with validated pageToken', async () => {
    const w = world();
    const top = w.fake.addComment({ videoId: w.videoId, text: 'top' });
    for (let i = 0; i < 3; i++) w.fake.addComment({ parentId: top, text: `r${i}` });

    const first = await w.connector.listComments(w.ctx, {
      sourceExternalId: top,
      cursor: null,
      limit: 2,
    });
    expect(w.apiCalls()[0]).toMatchObject({
      method: 'comments.list',
      units: 1,
      query: { parentId: top, part: 'snippet', maxResults: '2', textFormat: 'plainText' },
    });
    expect(first.items.map((c) => c.body)).toEqual(['r0', 'r1']);
    expect(first.items[0]).toMatchObject({ sourceExternalId: w.videoId, parentExternalId: top });
    expect(first.nextCursor).toBe('p2');

    const second = await w.connector.listComments(w.ctx, {
      sourceExternalId: top,
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(w.apiCalls()[1]!.query['pageToken']).toBe('p2');
    expect(second.items.map((c) => c.body)).toEqual(['r2']);
    expect(second.nextCursor).toBeNull();

    await expect(
      w.connector.listComments(w.ctx, { sourceExternalId: top, cursor: 'a/b', limit: 2 }),
    ).rejects.toMatchObject({ code: 'invalid_platform_id' });
    await expect(
      w.connector.listComments(w.ctx, { sourceExternalId: 'x&id=1', cursor: null, limit: 2 }),
    ).rejects.toMatchObject({ code: 'invalid_platform_id' });
    expect(w.apiCalls()).toHaveLength(2);

    w.tamper('/comments', (json) => ({ ...json, nextPageToken: '../p4' }));
    await expect(
      w.connector.listComments(w.ctx, { sourceExternalId: top, cursor: null, limit: 2 }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('getComment reads one comment by id and returns null when it is gone', async () => {
    const w = world();
    const top = w.fake.addComment({ videoId: w.videoId, authorChannelId: VIEWER, text: 'hi' });
    const got = await w.connector.getComment(w.ctx, {
      sourceExternalId: w.videoId,
      externalId: top,
    });
    expect(w.apiCalls()[0]).toMatchObject({
      method: 'comments.list',
      query: { id: top, part: 'snippet', textFormat: 'plainText' },
    });
    expect(got).toMatchObject({
      externalId: top,
      sourceExternalId: w.videoId,
      body: 'hi',
      platformState: 'visible',
    });
    w.fake.updateComment(top, { status: 'rejected' });
    expect(
      await w.connector.getComment(w.ctx, { sourceExternalId: w.videoId, externalId: top }),
    ).toBeNull();
  });
});
