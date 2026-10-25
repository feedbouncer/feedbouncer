import { describe, expect, it } from 'vitest';
import type { CommentRef } from '@feedbouncer/connectors';
import { world } from './test-world.js';

const VIEWER = 'UC' + 'v'.repeat(22);

function seed(w: ReturnType<typeof world>, n: number, author = VIEWER): CommentRef[] {
  return Array.from({ length: n }, (_, i) => ({
    sourceExternalId: w.videoId,
    externalId: w.fake.addComment({ videoId: w.videoId, authorChannelId: author, text: `c${i}` }),
  }));
}
const writes = (w: ReturnType<typeof world>) =>
  w.apiCalls().filter((c) => c.method === 'comments.setModerationStatus');

describe('actBatch', () => {
  it('actBatch rejects 50 ids in one 50-unit call', async () => {
    const w = world();
    const targets = seed(w, 50);
    const out = await w.connector.actBatch!(w.ctx, { action: 'delete', targets });
    expect(out).toEqual({ status: 'applied' });
    expect(w.apiCalls()).toEqual([
      {
        method: 'comments.setModerationStatus',
        units: 50,
        query: { id: targets.map((t) => t.externalId).join(','), moderationStatus: 'rejected' },
      },
    ]);
    expect(w.quota.reserved).toEqual([
      { method: 'comments.setModerationStatus', units: 50, purpose: 'write' },
    ]);
    for (const t of targets) expect(w.fake.comment(t.externalId)!.status).toBe('rejected');
    expect(w.fake.isBanned(VIEWER)).toBe(false);
  });

  it('maps hide to heldForReview and unhide to published', async () => {
    const w = world();
    const targets = seed(w, 2);
    expect(await w.connector.actBatch!(w.ctx, { action: 'hide', targets })).toEqual({
      status: 'applied',
    });
    expect(w.fake.comment(targets[0]!.externalId)!.status).toBe('heldForReview');
    expect(await w.connector.actBatch!(w.ctx, { action: 'unhide', targets })).toEqual({
      status: 'applied',
    });
    expect(writes(w).map((c) => c.query['moderationStatus'])).toEqual([
      'heldForReview',
      'published',
    ]);
    expect(w.fake.comment(targets[1]!.externalId)!.status).toBe('published');
  });

  it('ban_author sends rejected + banAuthor=true', async () => {
    const w = world();
    const targets = seed(w, 2);
    expect(await w.connector.actBatch!(w.ctx, { action: 'ban_author', targets })).toEqual({
      status: 'applied',
    });
    expect(writes(w)[0]!.query).toEqual({
      id: targets.map((t) => t.externalId).join(','),
      moderationStatus: 'rejected',
      banAuthor: 'true',
    });
    expect(w.fake.isBanned(VIEWER)).toBe(true);
  });

  it('51 targets → batch_too_large without any call', async () => {
    const w = world();
    const targets = seed(w, 51);
    await expect(w.connector.actBatch!(w.ctx, { action: 'delete', targets })).rejects.toMatchObject(
      { kind: 'permanent', code: 'batch_too_large' },
    );
    expect(w.apiCalls()).toHaveLength(0);
    expect(w.quota.reserved).toHaveLength(0);
  });

  it('refuses a malformed id or an unsupported action without any call', async () => {
    const w = world();
    const [t] = seed(w, 1);
    await expect(
      w.connector.actBatch!(w.ctx, {
        action: 'delete',
        targets: [t!, { sourceExternalId: w.videoId, externalId: 'Ugz0000000001,Ugz0000000002' }],
      }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_platform_id' });
    await expect(
      w.connector.actBatch!(w.ctx, { action: 'report', targets: [t!] }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
    expect(w.apiCalls()).toHaveLength(0);
  });

  it('missing id → not_found', async () => {
    const w = world();
    const targets = [...seed(w, 2), { sourceExternalId: w.videoId, externalId: 'Ugz999999999999' }];
    expect(await w.connector.actBatch!(w.ctx, { action: 'delete', targets })).toEqual({
      status: 'not_found',
    });
    expect(writes(w)).toHaveLength(1);
  });

  it('hold after API publish → hold_not_allowed', async () => {
    const w = world();
    const targets = seed(w, 1);
    await w.connector.actBatch!(w.ctx, { action: 'hide', targets });
    await w.connector.actBatch!(w.ctx, { action: 'unhide', targets });
    await expect(w.connector.actBatch!(w.ctx, { action: 'hide', targets })).rejects.toMatchObject({
      kind: 'permanent',
      code: 'hold_not_allowed',
    });
  });

  it('error messages never carry the response body or the token', async () => {
    const w = world();
    const targets = seed(w, 1);
    w.fake.failNext('backendError', 503);
    const err = await w.connector.actBatch!(w.ctx, { action: 'delete', targets }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'transient', code: 'platform_unavailable' });
    const text = `${String(err.message)} ${JSON.stringify(err)}`;
    expect(text).not.toContain('fake error');
    expect(text).not.toContain(w.ctx.accessToken.reveal());
  });
});

describe('act', () => {
  it('is actBatch with one target', async () => {
    const w = world();
    const [t] = seed(w, 1);
    expect(await w.connector.act(w.ctx, { action: 'hide', target: t! })).toEqual({
      status: 'applied',
      platformActionId: null,
    });
    expect(writes(w)[0]!.query).toEqual({ id: t!.externalId, moderationStatus: 'heldForReview' });
    expect(
      await w.connector.act(w.ctx, {
        action: 'delete',
        target: { sourceExternalId: w.videoId, externalId: 'Ugz999999999999' },
      }),
    ).toEqual({ status: 'not_found' });
  });
});

describe('probeComments', () => {
  it('probe reports held, visible, and gone (rejected/deleted)', async () => {
    const w = world();
    const [visible, held, rejected, deleted] = seed(w, 4);
    w.fake.updateComment(held!.externalId, { status: 'heldForReview' });
    w.fake.updateComment(rejected!.externalId, { status: 'rejected' });
    w.fake.updateComment(deleted!.externalId, { status: 'deleted' });
    const refs = [visible!, held!, rejected!, deleted!];

    const probes = await w.connector.probeComments!(w.ctx, refs);

    expect(w.apiCalls()).toEqual([
      {
        method: 'comments.list',
        units: 1,
        query: {
          id: refs.map((r) => r.externalId).join(','),
          part: 'snippet',
          textFormat: 'plainText',
        },
      },
    ]);
    expect(probes).toEqual([
      {
        externalId: visible!.externalId,
        state: 'visible',
        updatedAt: expect.any(Date),
        authorExternalId: VIEWER,
      },
      {
        externalId: held!.externalId,
        state: 'held',
        updatedAt: expect.any(Date),
        authorExternalId: VIEWER,
      },
      { externalId: rejected!.externalId, state: 'gone', updatedAt: null, authorExternalId: null },
      { externalId: deleted!.externalId, state: 'gone', updatedAt: null, authorExternalId: null },
    ]);
  });

  it('an item without moderationStatus probes as visible', async () => {
    const w = world();
    const [c] = seed(w, 1);
    w.fake.updateComment(c!.externalId, { status: 'heldForReview' });
    w.tamper('/comments', (json) => {
      for (const i of json['items'] as { snippet: Record<string, unknown> }[]) {
        delete i.snippet['moderationStatus'];
      }
      return json;
    });
    expect((await w.connector.probeComments!(w.ctx, [c!]))[0]).toMatchObject({ state: 'visible' });
  });

  it('refuses more than 50 refs without any call', async () => {
    const w = world();
    const refs = Array.from({ length: 51 }, (_, i) => ({
      sourceExternalId: w.videoId,
      externalId: `Ugz${String(i).padStart(12, '0')}`,
    }));
    await expect(w.connector.probeComments!(w.ctx, refs)).rejects.toMatchObject({
      code: 'batch_too_large',
    });
    expect(w.apiCalls()).toHaveLength(0);
  });
});
