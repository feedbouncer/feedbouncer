import { beforeEach, describe, expect, it } from 'vitest';
import { FakeYouTube } from './fake-youtube.js';

const CHANNEL = 'UC' + 'c'.repeat(22);
const AUTHOR = 'UC' + 'a'.repeat(22);
const T0 = Date.parse('2026-10-24T10:00:00Z');

let now: number;
let fake: FakeYouTube;
let token: string;

beforeEach(() => {
  now = T0;
  fake = new FakeYouTube({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    channel: { id: CHANNEL, title: 'My channel' },
    clock: () => now,
  });
  token = fake.issueAccessToken();
});

const api = (path: string, q: Record<string, string>, method = 'GET', t = token) =>
  fake.fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams(q)}`, {
    method,
    headers: { authorization: `Bearer ${t}` },
  });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const reason = async (r: Response) =>
  ((await json(r)) as { error: { errors: { reason: string }[] } }).error.errors[0]!.reason;

describe('FakeYouTube', () => {
  it('rejects a call without a known bearer token with 401', async () => {
    const r = await api('channels', { mine: 'true', part: 'snippet' }, 'GET', 'nope');
    expect(r.status).toBe(401);
  });

  it('lists published threads only unless moderationStatus is given', async () => {
    const v = fake.addVideo();
    const pub = fake.addComment({ videoId: v, text: 'hello' });
    const held = fake.addComment({ videoId: v, text: 'held', status: 'heldForReview' });
    const q = { allThreadsRelatedToChannelId: CHANNEL, part: 'snippet,replies' };
    const ids = async (extra: Record<string, string>) =>
      ((await json(await api('commentThreads', { ...q, ...extra }))).items as { id: string }[]).map(
        (i) => i.id,
      );
    expect(await ids({})).toEqual([pub]);
    expect(await ids({ moderationStatus: 'heldForReview' })).toEqual([held]);
  });

  it('commentsDisabled video answers 403 commentsDisabled', async () => {
    const v = fake.addVideo({ commentsDisabled: true });
    const r = await api('commentThreads', { videoId: v, part: 'snippet' });
    expect(r.status).toBe(403);
    expect(await reason(r)).toBe('commentsDisabled');
  });

  it('setModerationStatus: 204, ≤50 ids, whole-call 404, and no hold after an API publish', async () => {
    const v = fake.addVideo();
    const a = fake.addComment({ videoId: v, text: 'a' });
    const b = fake.addComment({ videoId: v, text: 'b' });
    const set = (id: string, status: string, extra: Record<string, string> = {}) =>
      api('comments/setModerationStatus', { id, moderationStatus: status, ...extra }, 'POST');

    expect((await set(`${a},${b}`, 'heldForReview')).status).toBe(204);
    expect(fake.comment(a)!.status).toBe('heldForReview');

    const missing = await set(`${a},UgxMissing0000`, 'rejected');
    expect(missing.status).toBe(404);
    expect(fake.comment(a)!.status).toBe('heldForReview');

    expect((await set(a, 'published')).status).toBe(204);
    const again = await set(a, 'heldForReview');
    expect(again.status).toBe(400);
    expect(await reason(again)).toBe('operationNotSupported');

    const tooMany = Array.from({ length: 51 }, () => fake.addComment({ videoId: v, text: 'x' }));
    expect((await set(tooMany.join(','), 'rejected')).status).toBe(400);
  });

  it('banAuthor rejects and bans; later comments by that author are created rejected', async () => {
    const v = fake.addVideo();
    const c = fake.addComment({ videoId: v, text: 'spam', authorChannelId: AUTHOR });
    const r = await api(
      'comments/setModerationStatus',
      { id: c, moderationStatus: 'rejected', banAuthor: 'true' },
      'POST',
    );
    expect(r.status).toBe(204);
    expect(fake.comment(c)!.status).toBe('rejected');
    expect(fake.isBanned(AUTHOR)).toBe(true);
    const later = fake.addComment({ videoId: v, text: 'again', authorChannelId: AUTHOR });
    expect(fake.comment(later)!.status).toBe('rejected');
  });

  it('charges units per call, refuses past the limit, and resets at Pacific midnight', async () => {
    fake.exhaustQuotaAt(2);
    const q = { mine: 'true', part: 'snippet' };
    expect((await api('channels', q)).status).toBe(200);
    expect((await api('channels', q)).status).toBe(200);
    const over = await api('channels', q);
    expect(over.status).toBe(403);
    expect(await reason(over)).toBe('quotaExceeded');
    expect(fake.unitsUsed).toBe(2);
    expect(fake.calls.map((c) => c.units)).toEqual([1, 1, 0]);
    // 2026-10-25T07:00Z is midnight in Los Angeles (PDT, UTC-7).
    now = Date.parse('2026-10-25T06:59:59Z');
    token = fake.issueAccessToken();
    expect((await api('channels', q)).status).toBe(403);
    now = Date.parse('2026-10-25T07:00:00Z');
    expect((await api('channels', q)).status).toBe(200);
    expect(fake.unitsUsed).toBe(1);
  });

  it('failNext and failOn inject Google error bodies and still charge the call', async () => {
    fake.failNext('backendError', 500);
    const r = await api('channels', { mine: 'true', part: 'snippet' });
    expect(r.status).toBe(500);
    expect(await reason(r)).toBe('backendError');
    fake.failOn('comments.list', 'forbidden', 403);
    expect((await api('channels', { mine: 'true', part: 'snippet' })).status).toBe(200);
    expect((await api('comments', { id: 'UgxAbC123_-.def', part: 'snippet' })).status).toBe(403);
    expect(fake.calls.map((c) => [c.method, c.units])).toEqual([
      ['channels.list', 1],
      ['channels.list', 1],
      ['comments.list', 1],
    ]);
  });

  it('exchanges an authorization code once and refreshes; unknown refresh is invalid_grant', async () => {
    const code = fake.authorize();
    const form = (p: Record<string, string>) =>
      fake.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'client-id',
          client_secret: 'client-secret',
          ...p,
        }).toString(),
      });
    const ok = await json(
      await form({ grant_type: 'authorization_code', code, code_verifier: 'v', redirect_uri: 'r' }),
    );
    expect(ok.scope).toBe('https://www.googleapis.com/auth/youtube.force-ssl');
    expect(typeof ok.refresh_token).toBe('string');
    const replay = await form({ grant_type: 'authorization_code', code, code_verifier: 'v' });
    expect(replay.status).toBe(400);
    const refreshed = await form({
      grant_type: 'refresh_token',
      refresh_token: ok.refresh_token as string,
    });
    expect(refreshed.status).toBe(200);
    const bad = await form({ grant_type: 'refresh_token', refresh_token: 'unknown' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe('invalid_grant');
  });
});
