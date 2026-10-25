import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyFailure } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { CommentAppliedHook } from '../hooks.js';
import { THREADS_POLL_JOB } from '../jobs/specs.js';
import { threadsPollJob, type ThreadsPollResult } from './poll.js';
import { DAY_MS, SETTINGS, threadsWorld, type ThreadsWorld } from './test-world.js';

let w: ThreadsWorld;
beforeAll(async () => {
  w = await threadsWorld('poll');
});
afterAll(() => w.close());

const hook = () => {
  const onApplied = vi.fn<CommentAppliedHook['onApplied']>(async () => {});
  return { applied: { onApplied } as CommentAppliedHook, onApplied };
};
const poll = async (scope: ConnectionScope, applied?: CommentAppliedHook) =>
  (await threadsPollJob({
    runtime: w.runtime,
    directory: w.directory,
    polling: w.polling,
    store: w.store,
    clock: w.clock,
    settings: SETTINGS,
    ...(applied && { applied }),
  }).handle(w.jobCtx(scope), { bucket: 0 })) as ThreadsPollResult;

async function account(label: string) {
  const tenant = await w.tenant(label);
  return { tenant, ...(await w.connect(tenant)) };
}
const ago = (ms: number) => new Date(w.clock.now() - ms);
const wake = (scope: ConnectionScope, source: string, reply: string) =>
  w.polling.recordWake(scope, {
    sourceExternalId: source,
    replyExternalId: reply,
    receivedAt: w.now(),
  });
/** The fake's calls to `endpoint` made after this point (the fake keeps one log per world). */
const callsFrom = (endpoint: Parameters<typeof w.fake.calls>[0]) => {
  const from = w.fake.calls(endpoint).length;
  return () => w.fake.calls(endpoint).slice(from);
};
const byId = <T extends { external_id: string }>(rows: T[], id: string) =>
  rows.find((r) => r.external_id === id)!;
/** Past the poll interval and the discovery interval, so every schedule is due again. */
const later = () => w.advance((SETTINGS.discoveryIntervalSec + 1) * 1000);

describe('threads_poll', () => {
  it('first pass backfills replies at every depth as origin backfill and links parents', async () => {
    const { scope, userId } = await account('backfill');
    const { postId } = w.fake.addPost(userId, { at: ago(3 * DAY_MS) });
    const r1 = w.fake.addReply(postId, { at: ago(2 * DAY_MS), text: 'top' }).replyId;
    const r2 = w.fake.addReply(r1, { at: ago(2 * DAY_MS - 3_600_000), text: 'second' }).replyId;
    const r3 = w.fake.addReply(r2, { at: ago(2 * DAY_MS - 7_200_000), text: 'third' }).replyId;
    w.fake.addReply(postId, { at: ago(40 * DAY_MS), text: 'too old' });
    const media = callsFrom('media');

    const out = await poll(scope);
    expect(out).toMatchObject({ created: 3, updated: 0 });
    const rows = await w.comments(scope);
    expect(rows.map((r) => r.external_id).sort()).toEqual([r1, r2, r3].sort());
    expect(rows.every((r) => r.ingest_origin === 'backfill')).toBe(true);
    expect(rows.every((r) => r.source_external_id === postId)).toBe(true);
    expect(byId(rows, r1).parent_external_id).toBeNull();
    expect(byId(rows, r2).parent_external_id).toBe(r1);
    expect(byId(rows, r3).parent_external_id).toBe(r2);
    expect(byId(rows, r2).parent_comment_id).not.toBeNull();
    expect(byId(rows, r3).parent_comment_id).not.toBeNull();
    expect(media()).toEqual([]);
    expect((await w.sourcePoll(scope, postId))!.high_water_at).toEqual(ago(2 * DAY_MS - 7_200_000));
  });

  it('a reply stored before its parent is linked when the parent arrives', async () => {
    const { scope, userId } = await account('link');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    const parent = w.fake.addReply(postId, { at: ago(10 * 3_600_000), text: 'parent' }).replyId;
    for (let i = 0; i < 100; i++)
      w.fake.addReply(postId, { at: ago(9 * 3_600_000 - i * 1000), text: `filler ${i}` });
    const child = w.fake.addReply(parent, { at: ago(3_600_000), text: 'child' }).replyId;

    // The first conversation page holds the newest 100 replies, the child among them; the
    // throttle stops the pass before the page with the parent.
    w.throttleConversationAfter(1);
    await expect(poll(scope)).rejects.toMatchObject({ kind: 'rate_limited' });
    let rows = await w.comments(scope);
    expect(byId(rows, child).parent_comment_id).toBeNull();
    expect(rows.some((r) => r.external_id === parent)).toBe(false);

    w.throttleConversationAfter(null);
    w.advance(61_000);
    await poll(scope);
    rows = await w.comments(scope);
    expect(rows).toHaveLength(102);
    const parentRow = await w.pool.query<{ id: string }>(
      `SELECT id FROM comment WHERE connection_id = $1 AND external_id = $2`,
      [scope.connectionId, parent],
    );
    expect(byId(rows, child).parent_comment_id).toBe(parentRow.rows[0]!.id);
  });

  it('webhook then poll then webhook again → one comment row, rules hook called once', async () => {
    const { scope, userId } = await account('idem');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    const h = hook();
    await poll(scope, h.applied);
    w.advance(1000);
    const { replyId } = w.fake.addReply(postId, { at: ago(500), text: 'hello' });

    await wake(scope, postId, replyId);
    await poll(scope, h.applied);
    await wake(scope, postId, replyId);
    w.advance(1000);
    await poll(scope, h.applied);

    expect(await w.comments(scope)).toHaveLength(1);
    expect(h.onApplied).toHaveBeenCalledTimes(1);
    expect(h.onApplied.mock.calls[0]![0]).toMatchObject({
      platform: 'threads',
      body: 'hello',
      outcome: 'created',
    });
    expect(await w.pending(scope)).toEqual([]);
  });

  it('missed webhook: reply added with no wake is ingested by the timed pass; no duplicate', async () => {
    const { scope, userId } = await account('missed');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    w.fake.addReply(postId, { at: ago(120_000), text: 'old' });
    const h = hook();
    await poll(scope, h.applied);
    expect((await w.comments(scope)).map((c) => c.ingest_origin)).toEqual(['backfill']);

    w.advance(5 * 60_000);
    const { replyId } = w.fake.addReply(postId, { at: w.now(), text: 'new' });
    expect(await poll(scope, h.applied)).toMatchObject({ sources: 0 });
    expect(await w.comments(scope)).toHaveLength(1);

    w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
    expect(await poll(scope, h.applied)).toMatchObject({ created: 1 });
    const rows = await w.comments(scope);
    expect(rows).toHaveLength(2);
    expect(byId(rows, replyId).ingest_origin).toBe('live');

    w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
    expect(await poll(scope, h.applied)).toMatchObject({ created: 0 });
    expect(await w.comments(scope)).toHaveLength(2);
    expect(h.onApplied).toHaveBeenCalledTimes(1);
  });

  it('burst of 3000 wakes is ingested by conversation passes within budget', async () => {
    const { scope, userId } = await account('burst');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    const h = hook();
    await poll(scope, h.applied);
    w.advance(1000);

    const ids: string[] = [];
    for (let i = 0; i < 3000; i++)
      ids.push(w.fake.addReply(postId, { at: ago(120_000 - i * 40), text: `r${i}` }).replyId);
    for (const id of ids) await wake(scope, postId, id);
    expect(await w.pending(scope)).toHaveLength(3000);
    const before = { ...w.consumed };
    const conversation = callsFrom('conversation');
    const media = callsFrom('media');

    let runs = 0;
    for (;;) {
      await poll(scope, h.applied);
      runs++;
      const sp = await w.sourcePoll(scope, postId);
      if (sp!.resume_cursor === null || runs > 8) break;
    }

    const rows = await w.comments(scope);
    expect(rows).toHaveLength(3000);
    expect(new Set(rows.map((r) => r.external_id)).size).toBe(3000);
    expect(rows.every((r) => r.ingest_origin === 'live')).toBe(true);
    expect(h.onApplied).toHaveBeenCalledTimes(3000);
    expect(await w.pending(scope)).toEqual([]);
    expect(conversation().length).toBeGreaterThanOrEqual(30);
    expect(conversation().length).toBeLessThanOrEqual(35);
    expect(media()).toEqual([]);
    const spent = Object.entries(w.consumed).reduce(
      (sum, [k, v]) => sum + (v - (before[k] ?? 0)) * (k.endsWith(':shared') ? 1 : 0),
      0,
    );
    expect(spent).toBeLessThanOrEqual(35);
    expect(Object.values(w.consumed).every((v) => v >= 0)).toBe(true);
  });

  it('a wake for a post the account does not own stores nothing', async () => {
    const { scope } = await account('foreign');
    const stranger = w.fake.addUser({ username: 'stranger' });
    const { postId } = w.fake.addPost(stranger.userId, { at: ago(DAY_MS) });
    const { replyId } = w.fake.addReply(postId, { at: ago(60_000), text: 'injected' });
    const h = hook();
    const media = callsFrom('media');
    const conversation = callsFrom('conversation');

    await wake(scope, postId, replyId);
    expect(await w.pending(scope)).toHaveLength(1);
    const out = await poll(scope, h.applied);

    expect(out).toMatchObject({ foreign: 1, created: 0 });
    expect((await w.sourcePoll(scope, postId))!.owner_verified).toBe(false);
    expect(await w.pending(scope)).toEqual([]);
    expect(await w.comments(scope)).toEqual([]);
    expect(h.onApplied).not.toHaveBeenCalled();
    expect(media()).toHaveLength(1);
    expect(media()[0]).toMatchObject({ id: postId, query: { fields: 'id,owner' } });
    expect(conversation().some((c) => c.id === postId)).toBe(false);

    // Another notification for the same post is dropped, and the post is not looked at again.
    await wake(scope, postId, replyId);
    expect(await w.pending(scope)).toEqual([]);
    later();
    await poll(scope, h.applied);
    expect(media()).toHaveLength(1);
    expect(await w.comments(scope)).toEqual([]);
  });

  it("a woken post of the account's own that discovery has not listed yet is verified once and read", async () => {
    const { scope, userId } = await account('own-wake');
    w.fake.addPost(userId, { at: ago(DAY_MS) });
    await poll(scope);
    w.advance(60_000);
    const { postId } = w.fake.addPost(userId, { at: ago(30_000) });
    const { replyId } = w.fake.addReply(postId, { at: ago(10_000), text: 'hi' });
    await wake(scope, postId, replyId);
    const media = callsFrom('media');

    expect(await poll(scope)).toMatchObject({ sources: 1, created: 1, foreign: 0 });
    expect((await w.sourcePoll(scope, postId))!.owner_verified).toBe(true);
    expect(media()).toHaveLength(1);
    expect(await w.comments(scope)).toHaveLength(1);
  });

  it('pending id gone (deleted) → stored as deleted, never evaluated', async () => {
    const { scope, userId } = await account('gone');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    const h = hook();
    await poll(scope, h.applied);
    w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
    const { replyId } = w.fake.addReply(postId, { at: ago(3_600_000), text: 'soon gone' });
    await poll(scope, h.applied);
    expect(h.onApplied).toHaveBeenCalledTimes(1);

    w.fake.deleteReply(replyId);
    w.advance(1000);
    await wake(scope, postId, replyId);
    const out = await poll(scope, h.applied);

    expect(out).toMatchObject({ deleted: 1 });
    expect((await w.comments(scope)).map((c) => [c.external_id, c.platform_state])).toEqual([
      [replyId, 'deleted'],
    ]);
    expect(await w.pending(scope)).toEqual([]);
    expect(h.onApplied).toHaveBeenCalledTimes(1);
  });

  it('pending id unresolvable after 5 attempts is dropped and counted', async () => {
    const { scope, userId } = await account('unresolvable');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    await poll(scope);
    const ghost = '17849999999999999';
    w.fake.failNext('media', { httpStatus: 500, times: 5 });
    await wake(scope, postId, ghost);

    const dropped: number[] = [];
    for (let i = 0; i < 5; i++) {
      w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
      if (i > 0) expect((await w.pending(scope))[0]!.attempts).toBe(i);
      dropped.push((await poll(scope)).pendingDropped);
    }
    expect(dropped).toEqual([0, 0, 0, 0, 1]);
    expect(await w.pending(scope)).toEqual([]);
    expect(await w.comments(scope)).toEqual([]);
  });

  it('throttle on page 3 resumes from the cursor; high-water unchanged until complete', async () => {
    const { scope, userId } = await account('throttle');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    const h = hook();
    await poll(scope, h.applied);
    const high = (await w.sourcePoll(scope, postId))!.high_water_at;
    expect(high).toBeNull();

    w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
    for (let i = 0; i < 250; i++)
      w.fake.addReply(postId, { at: ago(3_000_000 - i * 1000), text: `r${i}` });
    const newest = ago(3_000_000 - 249_000);
    const before = w.fake.calls('conversation').length;
    w.throttleConversationAfter(2);
    await expect(poll(scope, h.applied)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(w.fake.calls('conversation').length - before).toBe(2);

    const mid = (await w.sourcePoll(scope, postId))!;
    expect(mid.resume_cursor).toBe('o200');
    expect(mid.high_water_at).toEqual(high);
    expect(await w.comments(scope)).toHaveLength(200);

    w.throttleConversationAfter(null);
    w.advance(61_000);
    await poll(scope, h.applied);
    const done = (await w.sourcePoll(scope, postId))!;
    expect(done.resume_cursor).toBeNull();
    expect(done.high_water_at).toEqual(newest);
    expect(await w.comments(scope)).toHaveLength(250);
    expect(w.fake.calls('conversation').length - before).toBe(3);
  });

  it('edited text found by the daily full scan updates the body and re-fires the hook once', async () => {
    const { scope, userId } = await account('edit');
    const { postId } = w.fake.addPost(userId, { at: ago(2 * DAY_MS) });
    const h = hook();
    await poll(scope, h.applied);
    w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
    const { replyId } = w.fake.addReply(postId, { at: ago(5 * 3_600_000), text: 'before' });
    w.fake.addReply(postId, { at: ago(3_600_000), text: 'newer' });
    await poll(scope, h.applied);
    expect(h.onApplied).toHaveBeenCalledTimes(2);

    // The timed pass reads back to the high-water mark less the overlap: the edit is out of reach.
    w.fake.editReply(replyId, 'after');
    w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
    await poll(scope, h.applied);
    expect(byId(await w.comments(scope), replyId).body).toBe('before');

    w.advance(DAY_MS);
    await poll(scope, h.applied);
    expect(byId(await w.comments(scope), replyId).body).toBe('after');
    expect(h.onApplied).toHaveBeenCalledTimes(3);
    expect(h.onApplied.mock.calls[2]![0]).toMatchObject({ body: 'after', outcome: 'updated' });

    w.advance((SETTINGS.pollIntervalSec + 1) * 1000);
    await poll(scope, h.applied);
    expect(h.onApplied).toHaveBeenCalledTimes(3);
  });

  it('empty-text media reply and emoji/RTL/CJK replies are stored byte-exact', async () => {
    const { scope, userId } = await account('bytes');
    const { postId } = w.fake.addPost(userId, { at: ago(DAY_MS) });
    const texts = ['', '🙂👍🏽 \u{1F1EE}\u{1F1F1}', 'שלום עולם مرحبا بالعالم', '你好，世界', 'é a‍b'];
    const ids = texts.map(
      (text, i) =>
        w.fake.addReply(postId, {
          at: ago(3_600_000 - i * 1000),
          text,
          ...(text === '' && { mediaType: 'IMAGE' }),
        }).replyId,
    );
    await poll(scope);
    const rows = await w.comments(scope);
    expect(ids.map((id) => byId(rows, id).body)).toEqual(texts);
  });

  it('an unreadable post is marked unavailable and does not stop the others', async () => {
    const { scope, userId } = await account('unavailable');
    const first = w.fake.addPost(userId, { at: ago(2 * DAY_MS) }).postId;
    const second = w.fake.addPost(userId, { at: ago(DAY_MS) }).postId;
    w.fake.addReply(first, { at: ago(3_600_000), text: 'a' });
    w.fake.addReply(second, { at: ago(3_600_000), text: 'b' });
    w.fake.failNext('conversation', { code: 10 });

    const out = await poll(scope);
    expect(out).toMatchObject({ unavailable: 1, done: 1, created: 1 });
    const rows = [await w.sourcePoll(scope, first), await w.sourcePoll(scope, second)];
    const bad = rows.find((r) => r!.unavailable_since !== null)!;
    expect(bad.last_error_code).toBe('permission_denied');
    expect(bad.next_poll_at.getTime()).toBeGreaterThan(w.clock.now());
  });

  it('a refused post listing marks the connection as missing threads_basic', async () => {
    const { scope } = await account('scope');
    w.fake.failNext('meThreads', { code: 10 });
    const err = await poll(scope).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'needs_reconnection' });
    const row = await w.connectionRow(scope);
    expect(row).toMatchObject({
      status: 'reconnect_required',
      status_reason: 'oauth_scope_missing',
      missing_scopes: ['threads_basic'],
    });
  });

  it('is a no-op for a connection that is no longer active', async () => {
    const t = await w.tenant('inactive');
    const scope = await w.insertConnection(t, '17850000000000001', 'paused');
    expect(await poll(scope)).toMatchObject({ sources: 0, created: 0 });
  });

  it('declares the job spec', () => {
    expect(THREADS_POLL_JOB).toMatchObject({
      type: 'threads_poll',
      platforms: ['threads'],
      policy: { maxAttempts: 5 },
      timeoutMs: 120_000,
    });
    expect(THREADS_POLL_JOB.externalRef({ bucket: 7 })).toBe('threads_poll:7');
  });
});
