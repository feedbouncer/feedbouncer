import { describe, expect, it } from 'vitest';
import { createSafeHttp } from '@feedbouncer/connectors';
import { THREADS_API_HOST } from './config.js';
import {
  REPLY_FIELDS,
  getComment,
  getPostOwner,
  listComments,
  listReplies,
  listSources,
  toNormalized,
} from './reading.js';
import { FakeThreads } from './testing/fake-threads.js';

const OWN = '9001';
const T0 = new Date('2026-10-01T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function world() {
  const fake = new FakeThreads({ appId: 'app', appSecret: 'secret', now: () => at(1000) });
  const owner = fake.addUser({ username: 'owner' });
  const token = 'tok';
  const call = (tok: string) => ({
    http: createSafeHttp({ allowedHosts: [THREADS_API_HOST], fetch: fake.fetch }),
    signal: AbortSignal.timeout(2000),
    accessToken: tok,
  });
  return { fake, owner, call, token };
}

async function authed() {
  const w = world();
  const res = await w.fake.fetch(`https://${THREADS_API_HOST}/oauth/access_token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'app',
      client_secret: 'secret',
      grant_type: 'authorization_code',
      redirect_uri: 'https://x.test/cb',
      code: w.owner.authCode,
    }),
  });
  const { access_token } = (await res.json()) as { access_token: string };
  return { ...w, c: w.call(access_token) };
}

const raw = (o: Record<string, unknown> = {}) => ({
  id: '100',
  text: 'hello',
  username: 'alice',
  permalink: 'https://www.threads.com/@alice/post/100',
  timestamp: '2026-10-01T10:00:00+0000',
  media_type: 'TEXT_POST',
  root_post: { id: '1' },
  replied_to: { id: '1' },
  is_reply: true,
  is_reply_owned_by_me: false,
  hide_status: 'NOT_HUSHED',
  ...o,
});
const opts = { ownAccountExternalId: OWN, sourceExternalId: '1' };

describe('toNormalized', () => {
  it('a depth-1 reply has parentExternalId null; a depth-3 reply points at its immediate parent', () => {
    expect(toNormalized(raw(), opts)!.parentExternalId).toBeNull();
    expect(toNormalized(raw({ replied_to: { id: '77' } }), opts)!.parentExternalId).toBe('77');
  });

  it('is_reply_owned_by_me maps the author to the own account id', () => {
    const c = toNormalized(raw({ is_reply_owned_by_me: true, username: 'owner' }), opts)!;
    expect(c.author).toEqual({
      externalId: OWN,
      displayName: 'owner',
      profileUrl: 'https://www.threads.com/@owner',
    });
    expect(toNormalized(raw(), opts)!.author).toEqual({
      externalId: 'alice',
      displayName: 'alice',
      profileUrl: 'https://www.threads.com/@alice',
    });
  });

  it('a private user (no username) has author null and is still returned', () => {
    const { username: _u, ...rest } = raw();
    void _u;
    const c = toNormalized(rest, opts)!;
    expect(c.author).toBeNull();
    expect(c.externalId).toBe('100');
  });

  it('media-only reply has body ""', () => {
    const { text: _t, ...rest } = raw({ media_type: 'IMAGE' });
    void _t;
    expect(toNormalized(rest, opts)!.body).toBe('');
  });

  it.each(['🔥🔥🔥', '👨‍👩‍👧', 'مرحبا', '你好', 'é', 'é'])(
    'emoji, ZWJ, Arabic RTL, CJK and combining marks round-trip unchanged: %s',
    (text) => {
      expect(toNormalized(raw({ text }), opts)!.body).toBe(text);
    },
  );

  it('HIDDEN → hidden; COVERED/RESTRICTED/NOT_HUSHED → visible', () => {
    const state = (h: string) => toNormalized(raw({ hide_status: h }), opts)!.platformState;
    expect(state('HIDDEN')).toBe('hidden');
    for (const h of ['COVERED', 'RESTRICTED', 'NOT_HUSHED', 'UNHUSHED', 'BLOCKED']) {
      expect(state(h)).toBe('visible');
    }
  });

  it('returns null for an invalid id, time or missing root_post', () => {
    expect(toNormalized(raw({ id: 'x/../1' }), opts)).toBeNull();
    expect(toNormalized(raw({ timestamp: 'yesterday' }), opts)).toBeNull();
    expect(toNormalized(raw({ replied_to: { id: '../' } }), opts)).toBeNull();
    expect(toNormalized({ id: '5' }, opts)).toBeNull();
  });

  it('keeps the posted time, a safe permalink and the source id', () => {
    const c = toNormalized(raw({ permalink: 'https://evil.test/x' }), opts)!;
    expect(c.postedAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(c.permalink).toBeNull();
    expect(c.sourceExternalId).toBe('1');
  });
});

describe('listComments', () => {
  it('lists the flattened conversation with fields and limit=100', async () => {
    const { fake, owner, c } = await authed();
    const { postId } = fake.addPost(owner.userId, { at: T0 });
    const r1 = fake.addReply(postId, { at: at(1), text: 'one' }).replyId;
    const r2 = fake.addReply(r1, { at: at(2), text: 'two' }).replyId;
    const page = await listComments(c, {
      ownAccountExternalId: owner.userId,
      sourceExternalId: postId,
      cursor: null,
    });
    expect(page.comments.map((x) => x.externalId).sort()).toEqual([r1, r2].sort());
    expect(page.comments.find((x) => x.externalId === r2)!.parentExternalId).toBe(r1);
    expect(page.comments.find((x) => x.externalId === r1)!.parentExternalId).toBeNull();
    expect(page.next).toBeNull();
    const q = fake.calls('conversation')[0]!.query;
    expect(q.fields).toBe(REPLY_FIELDS);
    expect(q.limit).toBe('100');
  });

  it('pages with the cursor', async () => {
    const { fake, owner, c } = await authed();
    const { postId } = fake.addPost(owner.userId, { at: T0 });
    for (let i = 0; i < 130; i++) fake.addReply(postId, { at: at(i + 1) });
    const first = await listComments(c, {
      ownAccountExternalId: owner.userId,
      sourceExternalId: postId,
      cursor: null,
    });
    expect(first.comments).toHaveLength(100);
    expect(first.next).not.toBeNull();
    const second = await listComments(c, {
      ownAccountExternalId: owner.userId,
      sourceExternalId: postId,
      cursor: first.next,
    });
    expect(second.comments).toHaveLength(30);
    expect(second.next).toBeNull();
  });

  it('an item with id "x/../1" is skipped, the rest of the page kept', async () => {
    const { c } = await authed();
    const bad = {
      http: createSafeHttp({
        allowedHosts: [THREADS_API_HOST],
        fetch: async () =>
          Response.json({
            data: [raw({ id: 'x/../1' }), raw({ id: '101' }), 'junk'],
            paging: { cursors: { after: 'abc' } },
          }),
      }),
      signal: c.signal,
      accessToken: 't',
    };
    const page = await listComments(bad, { ...opts, cursor: null });
    expect(page.comments.map((x) => x.externalId)).toEqual(['101']);
    expect(page.skippedInvalid).toBe(2);
    expect(page.skippedForeign).toBe(0);
    expect(page.next).toBe('abc');
  });

  it('an item whose root_post differs is counted foreign and dropped', async () => {
    const { c } = await authed();
    const stub = {
      http: createSafeHttp({
        allowedHosts: [THREADS_API_HOST],
        fetch: async () =>
          Response.json({ data: [raw({ id: '101', root_post: { id: '2' } }), raw({ id: '102' })] }),
      }),
      signal: c.signal,
      accessToken: 't',
    };
    const page = await listComments(stub, { ...opts, cursor: null });
    expect(page.comments.map((x) => x.externalId)).toEqual(['102']);
    expect(page.skippedForeign).toBe(1);
    expect(page.skippedInvalid).toBe(0);
  });

  it('a page with more than 100 items fails as an invalid response', async () => {
    const stub = {
      http: createSafeHttp({
        allowedHosts: [THREADS_API_HOST],
        fetch: async () => Response.json({ data: Array.from({ length: 101 }, () => ({})) }),
      }),
      signal: AbortSignal.timeout(2000),
      accessToken: 't',
    };
    await expect(listComments(stub, { ...opts, cursor: null })).rejects.toMatchObject({
      code: 'invalid_threads_response',
    });
  });

  it('drops a malformed cursor instead of following it', async () => {
    const stub = {
      http: createSafeHttp({
        allowedHosts: [THREADS_API_HOST],
        fetch: async () => Response.json({ data: [], paging: { cursors: { after: 'a b&c' } } }),
      }),
      signal: AbortSignal.timeout(2000),
      accessToken: 't',
    };
    expect((await listComments(stub, { ...opts, cursor: null })).next).toBeNull();
  });
});

describe('listReplies / getComment / getPostOwner', () => {
  it('listReplies returns the direct children of the target', async () => {
    const { fake, owner, c } = await authed();
    const { postId } = fake.addPost(owner.userId, { at: T0 });
    const r1 = fake.addReply(postId, { at: at(1) }).replyId;
    const r2 = fake.addReply(r1, { at: at(2), byUserId: owner.userId }).replyId;
    fake.addReply(r2, { at: at(3) });
    const out = await listReplies(c, {
      ownAccountExternalId: owner.userId,
      target: { sourceExternalId: postId, externalId: r1 },
    });
    expect(out.map((x) => x.externalId)).toEqual([r2]);
    expect(out[0]!.author!.externalId).toBe(owner.userId);
    expect(fake.calls('replies')[0]!.query.fields).toBe(REPLY_FIELDS);
  });

  it('getComment returns the reply and a deleted reply → null', async () => {
    const { fake, owner, c } = await authed();
    const { postId } = fake.addPost(owner.userId, { at: T0 });
    const r1 = fake.addReply(postId, { at: at(1), text: 'hi' }).replyId;
    const ref = { sourceExternalId: postId, externalId: r1 };
    const got = await getComment(c, { ownAccountExternalId: owner.userId, ref });
    expect(got!.body).toBe('hi');
    fake.deleteReply(r1);
    expect(await getComment(c, { ownAccountExternalId: owner.userId, ref })).toBeNull();
  });

  it('getComment on a reply of another post → null', async () => {
    const { fake, owner, c } = await authed();
    const a = fake.addPost(owner.userId, { at: T0 }).postId;
    const b = fake.addPost(owner.userId, { at: T0 }).postId;
    const r = fake.addReply(a, { at: at(1) }).replyId;
    expect(
      await getComment(c, {
        ownAccountExternalId: owner.userId,
        ref: { sourceExternalId: b, externalId: r },
      }),
    ).toBeNull();
  });

  it('getPostOwner returns owner.id, null when the post is gone', async () => {
    const stub = (body: unknown, status = 200) => ({
      http: createSafeHttp({
        allowedHosts: [THREADS_API_HOST],
        fetch: async () => Response.json(body, { status }),
      }),
      signal: AbortSignal.timeout(2000),
      accessToken: 't',
    });
    expect(await getPostOwner(stub({ id: '5', owner: { id: '42' } }), '5')).toBe('42');
    expect(await getPostOwner(stub({ id: '5' }), '5')).toBeNull();
    expect(
      await getPostOwner(stub({ error: { code: 100, error_subcode: 33 } }, 400), '5'),
    ).toBeNull();
  });
});

describe('listSources', () => {
  it('listSources uses since as unix seconds and limit=100', async () => {
    const { fake, owner, c } = await authed();
    const p1 = fake.addPost(owner.userId, { at: at(1) }).postId;
    const page = await listSources(c, { since: new Date('2026-09-01T00:00:00Z'), cursor: null });
    const q = fake.calls('meThreads')[0]!.query;
    expect(q.since).toBe(String(Date.parse('2026-09-01T00:00:00Z') / 1000));
    expect(q.limit).toBe('100');
    expect(page.sources).toEqual([
      {
        externalId: p1,
        kind: 'thread',
        permalink: expect.stringContaining(p1),
        active: true,
        postedAt: at(1),
      },
    ]);
    expect(page.next).toBeNull();
  });
});
