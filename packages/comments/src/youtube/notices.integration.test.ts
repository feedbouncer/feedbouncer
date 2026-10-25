// Once-per-day owner emails, over Postgres and the memory mailer.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Mailer } from '@feedbouncer/mailer';
import { PgYouTubeBacklog } from './backlog.js';
import { YouTubeNotices } from './notices.js';
import { youtubeWorld, type YouTubeWorld } from './test-world.js';

let w: YouTubeWorld;
beforeAll(async () => {
  w = await youtubeWorld('notices');
});
afterAll(() => w.close());
beforeEach(() => w.reset());

const sentTo = async (userId: string) => {
  const { rows } = await w.pool.query<{ email: string }>(
    'SELECT email FROM app_user WHERE id = $1',
    [userId],
  );
  return w.mailer.sent.filter((m) => m.to === rows[0]!.email);
};
const make = (o: { mailer?: Mailer; pool?: typeof w.pool } = {}) =>
  new YouTubeNotices({
    pool: o.pool ?? w.pool,
    mailer: o.mailer ?? w.mailer,
    publicWebUrl: new URL('https://app.test'),
    log: w.log,
    clock: w.clock,
  });
const warned = (msg: string) => w.lines.filter((l) => l.level === 'warn' && l.msg === msg);

describe('YouTubeNotices', () => {
  it('claims a notice once per connection, kind and Pacific day', async () => {
    const c = await w.connect('once');
    const other = await w.connect('once-other');

    expect(await w.notices.once(c.scope, 'quota_paused', 3)).toBe(true);
    expect(await w.notices.once(c.scope, 'quota_paused', 3)).toBe(false);
    expect(await w.notices.once(other.scope, 'quota_paused', 1)).toBe(true);
    expect(await sentTo(c.userId)).toHaveLength(1);
    expect(await sentTo(other.userId)).toHaveLength(1);

    w.advance(86_400_000);
    expect(await w.notices.once(c.scope, 'quota_paused', 3)).toBe(true);
    expect(await sentTo(c.userId)).toHaveLength(2);
  });

  it('emails every owner of the organization, and no one else', async () => {
    const c = await w.connect('owners');
    const second = await w.pool.query<{ id: string }>(
      "INSERT INTO app_user (email) VALUES ('second-owner@example.test') RETURNING id",
    );
    await w.pool.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
      [c.scope.organizationId, second.rows[0]!.id],
    );
    const member = await w.pool.query<{ id: string }>(
      "INSERT INTO app_user (email) VALUES ('plain-member@example.test') RETURNING id",
    );
    await w.pool.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'member')",
      [c.scope.organizationId, member.rows[0]!.id],
    );
    const bystander = await w.connect('owners-bystander');

    await w.notices.once(c.scope, 'quota_paused', 2);

    expect(await sentTo(c.userId)).toHaveLength(1);
    expect(await sentTo(second.rows[0]!.id)).toHaveLength(1);
    expect(await sentTo(member.rows[0]!.id)).toHaveLength(0);
    expect(await sentTo(bystander.userId)).toHaveLength(0);
    const mail = (await sentTo(c.userId))[0]!;
    expect(mail.text).toContain(
      `/orgs/${c.scope.organizationId}/brands/${c.scope.brandId}/connections`,
    );
    expect(mail.text).toContain('2 moderation actions');
  });

  it('logs a failed send and does not throw or retry that day', async () => {
    const c = await w.connect('send-fails');
    const notices = make({
      mailer: { send: () => Promise.reject(new Error('smtp down: secret-host')) },
    });

    expect(await notices.once(c.scope, 'quota_paused', 1)).toBe(true);
    expect(await notices.once(c.scope, 'quota_paused', 1)).toBe(false);

    expect(warned('youtube.notice_send_failed')).toHaveLength(1);
    expect(JSON.stringify(w.lines)).not.toContain('secret-host');
  });

  it('logs a failed claim and does not throw', async () => {
    const c = await w.connect('claim-fails');
    const broken = {
      query: () => Promise.reject(new Error('db down')),
    } as unknown as typeof w.pool;

    expect(await make({ pool: broken }).once(c.scope, 'quota_paused', 1)).toBe(false);

    expect(warned('youtube.notice_failed')).toHaveLength(1);
    expect(await sentTo(c.userId)).toHaveLength(0);
  });

  it('sends the backlog overflow notice only once something overflowed', async () => {
    const c = await w.connect('overflow');
    expect(await w.notices.once(c.scope, 'backlog_overflow')).toBe(false);
    expect(await sentTo(c.userId)).toHaveLength(0);

    const small = new PgYouTubeBacklog({
      pool: w.pool,
      clock: w.clock,
      cap: 1,
      log: w.log,
      outcomes: w.observer,
    });
    await w.queuedAction(c, 'ban_author');
    const hold = await w.queuedAction(c, 'hide');
    const reject = await w.queuedAction(c, 'delete');
    await small.enqueue(c.scope, {
      actionId: reject.actionId,
      commentId: reject.commentId,
      kind: 'delete',
      requestedAt: w.now(),
    });
    expect((await w.action(hold.actionId)).outcome_code).toBe('backlog_overflow');

    expect(await w.notices.once(c.scope, 'backlog_overflow')).toBe(true);
    expect(await w.notices.once(c.scope, 'backlog_overflow')).toBe(false);
    const mails = await sentTo(c.userId);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('could not queue');
  });
});
