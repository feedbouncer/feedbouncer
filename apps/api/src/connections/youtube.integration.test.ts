import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pacificDayKey } from '@feedbouncer/comments';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const YOUTUBE = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: new Secret('youtube-secret-0123456789'),
  projectDailyQuota: 10_000,
  projectHeadroomUnits: 1000,
  schedulerTickSec: 60,
  backlogCap: 5000,
};
const CHANNEL = (n: number) => `UC${String(n).padStart(22, 'a')}`;

let api: TestApi;
let A: OrgFixture;
let B: OrgFixture;
let connectionId: string;
let bConnectionId: string;
let facebookId: string;

const url = (f: OrgFixture, id: string, tail = '') =>
  `/api/v1/orgs/${f.orgId}/brands/${f.brandId}/connections/${id}/youtube${tail}`;
const patch = (body: unknown, cookie = A.owner.cookie) =>
  api.req('PATCH', url(A, connectionId), { cookie, body });

async function seed(f: OrgFixture, platform: 'youtube' | 'facebook', ext: string) {
  const { scope } = await api.seedConnection(f, { platform, externalAccountId: ext });
  return scope.connectionId;
}

beforeAll(async () => {
  api = await startTestApi({ youtube: YOUTUBE });
  A = await orgWithRoles(api, 'yta');
  B = await orgWithRoles(api, 'ytb');
  connectionId = await seed(A, 'youtube', CHANNEL(1));
  bConnectionId = await seed(B, 'youtube', CHANNEL(2));
  facebookId = await seed(A, 'facebook', '100000000000001');
});
afterAll(() => api.close());

describe('GET youtube settings and budget status', () => {
  it("returns defaults and today's usage with mode active", async () => {
    const r = await api.req('GET', url(A, connectionId), { cookie: A.owner.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      settings: { dailyBudgetUnits: 2000, dryRun: false, protectedAuthorIds: [] },
      limits: { maxBudgetUnits: 9000, projectQuotaUnits: 10_000 },
      today: {
        mode: 'active',
        budgetUnits: 2000,
        spentUnits: 0,
        readsSpentUnits: 0,
        writesSpentUnits: 0,
        readReserveUnits: 300,
        remainingUnits: 2000,
        simulatedUnits: 0,
        pausedUntil: null,
      },
      backlog: { ban: 0, reject: 0, hold: 0, publish: 0, skippedOverflowToday: 0 },
      lastErrorCode: null,
    });
    expect(r.body.today.pacificDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(r.body.today.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('counts real and simulated spend, overflow notices and the project pause', async () => {
    const id = await seed(A, 'youtube', CHANNEL(3));
    const ids = [A.orgId, A.brandId, id];
    await api.pool.query(
      `INSERT INTO youtube_quota_ledger (call_key, pacific_day, organization_id, brand_id, connection_id, method, purpose, units, simulated)
       VALUES ('k-r', (now() AT TIME ZONE 'America/Los_Angeles')::date, $1, $2, $3, 'commentThreads.list', 'read', 7, false),
              ('k-w', (now() AT TIME ZONE 'America/Los_Angeles')::date, $1, $2, $3, 'comments.setModerationStatus', 'write', 50, false),
              ('k-s', (now() AT TIME ZONE 'America/Los_Angeles')::date, $1, $2, $3, 'comments.setModerationStatus', 'write', 50, true)`,
      ids,
    );
    await api.pool.query(
      `INSERT INTO youtube_notice (organization_id, brand_id, connection_id, kind, pacific_day, count)
       VALUES ($1, $2, $3, 'backlog_overflow', (now() AT TIME ZONE 'America/Los_Angeles')::date, 4)`,
      ids,
    );
    const ok = await api.req('GET', url(A, id), { cookie: A.owner.cookie });
    expect(ok.body.today).toMatchObject({
      spentUnits: 57,
      readsSpentUnits: 7,
      writesSpentUnits: 50,
      simulatedUnits: 50,
      remainingUnits: 1943,
    });
    expect(ok.body.backlog.skippedOverflowToday).toBe(4);
    await api.pool.query(
      `INSERT INTO youtube_quota_pause (pacific_day, reason, resume_at)
       VALUES ((now() AT TIME ZONE 'America/Los_Angeles')::date, 'quota_exceeded', now() + interval '1 hour')`,
    );
    const paused = await api.req('GET', url(A, id), { cookie: A.owner.cookie });
    expect(paused.body.today.mode).toBe('paused');
    expect(new Date(paused.body.today.pausedUntil).getTime()).toBeGreaterThan(Date.now());
    await api.pool.query('DELETE FROM youtube_quota_pause');
  });

  it('is 404 when YouTube is not configured', async () => {
    const off = await startTestApi({}, {});
    try {
      const f = await orgWithRoles(off, 'ytoff');
      const { scope } = await off.seedConnection(f, {
        platform: 'youtube',
        externalAccountId: CHANNEL(9),
      });
      const r = await off.req('GET', url(f, scope.connectionId), { cookie: f.owner.cookie });
      expect(r.status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe('PATCH youtube settings', () => {
  it('validates the body', async () => {
    for (const body of [
      { dailyBudgetUnits: 9001 },
      { dailyBudgetUnits: -1 },
      { dailyBudgetUnits: 1.5 },
      { dailyBudgetUnits: '5' },
      { dryRun: 'yes' },
      { unknown: 1 },
      { protectedAuthorIds: [CHANNEL(1).slice(0, -1)] },
      { protectedAuthorIds: ['UC' + 'a'.repeat(21) + '!'] },
      { protectedAuthorIds: Array.from({ length: 201 }, (_, i) => CHANNEL(i)) },
    ]) {
      const r = await patch(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await patch({ dailyBudgetUnits: 9000 })).status).toBe(200);
  });

  it('stores deduplicated settings, merges partial patches and audits counts only', async () => {
    const id = await seed(A, 'youtube', CHANNEL(4));
    const r = await api.req('PATCH', url(A, id), {
      cookie: A.admin.cookie,
      body: { dailyBudgetUnits: 0, protectedAuthorIds: [CHANNEL(5), CHANNEL(5), CHANNEL(6)] },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({
      dailyBudgetUnits: 0,
      dryRun: false,
      protectedAuthorIds: [CHANNEL(5), CHANNEL(6)],
    });
    expect(r.body.today.mode).toBe('disabled');
    const dry = await api.req('PATCH', url(A, id), {
      cookie: A.owner.cookie,
      body: { dryRun: true },
    });
    expect(dry.body.settings).toMatchObject({ dailyBudgetUnits: 0, dryRun: true });
    const get = await api.req('GET', url(A, id), { cookie: A.owner.cookie });
    expect(get.body.settings.protectedAuthorIds).toEqual([CHANNEL(5), CHANNEL(6)]);
    const { rows } = await api.pool.query(
      `SELECT actor_user_id, brand_id, subject_type, subject_id, details FROM audit_event
        WHERE action = 'connection.youtube_settings_updated' AND subject_id = $1 ORDER BY created_at`,
      [id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actor_user_id: A.admin.userId,
      brand_id: A.brandId,
      subject_type: 'connection',
      details: { dailyBudgetUnits: 0, dryRun: false, protectedAuthorCount: 2 },
    });
    expect(rows[1].details).toEqual({ dailyBudgetUnits: 0, dryRun: true, protectedAuthorCount: 2 });
    expect(JSON.stringify(rows)).not.toContain(CHANNEL(5));
  });

  it('wakes a sleeping connection when the budget or dry-run changes, but not for other edits', async () => {
    const id = await seed(A, 'youtube', CHANNEL(7));
    const other = await seed(A, 'youtube', CHANNEL(8));
    for (const c of [id, other]) {
      await api.pool.query(
        `INSERT INTO youtube_connection_state (organization_id, brand_id, connection_id, next_read_at, next_dispatch_at)
         VALUES ($1, $2, $3, now() + interval '10 hours', now() + interval '10 hours')`,
        [A.orgId, A.brandId, c],
      );
    }
    const due = async (c: string) =>
      (
        await api.pool.query<{ read: boolean; dispatch: boolean }>(
          `SELECT next_read_at <= now() AS read, next_dispatch_at <= now() AS dispatch
             FROM youtube_connection_state WHERE connection_id = $1`,
          [c],
        )
      ).rows[0];
    const protectedOnly = await api.req('PATCH', url(A, id), {
      cookie: A.owner.cookie,
      body: { protectedAuthorIds: [CHANNEL(1)] },
    });
    expect(protectedOnly.status).toBe(200);
    expect(await due(id)).toEqual({ read: false, dispatch: false });
    expect((await patchOn(id, { dailyBudgetUnits: 500 })).status).toBe(200);
    expect(await due(id)).toEqual({ read: true, dispatch: true });
    expect(await due(other)).toEqual({ read: false, dispatch: false });
    await api.pool.query(
      `UPDATE youtube_connection_state SET next_read_at = now() + interval '1 hour' WHERE connection_id = $1`,
      [id],
    );
    expect((await patchOn(id, { dryRun: true })).status).toBe(200);
    expect((await due(id))?.read).toBe(true);
  });

  it('member role cannot PATCH or GET', async () => {
    expect((await patch({ dryRun: true }, A.member.cookie)).status).toBe(403);
    const get = await api.req('GET', url(A, connectionId), { cookie: A.member.cookie });
    expect(get.status).toBe(403);
  });

  it('requires a session', async () => {
    const r = await api.req('PATCH', url(A, connectionId), { body: { dryRun: true } });
    expect(r.status).toBe(401);
  });
});

function patchOn(id: string, body: unknown) {
  return api.req('PATCH', url(A, id), { cookie: A.owner.cookie, body });
}

describe('tenant scoping', () => {
  it("another organization's or brand's connection is 404 with the missing-connection body", async () => {
    const missing = await api.req('GET', url(A, '00000000-0000-4000-8000-000000000000'), {
      cookie: A.owner.cookie,
    });
    expect(missing.status).toBe(404);
    const otherBrand = await api.req('POST', `/api/v1/orgs/${A.orgId}/brands`, {
      cookie: A.owner.cookie,
      body: { name: 'second' },
    });
    const sameOrgOtherBrand = { ...A, brandId: otherBrand.body.brand.id as string };
    const calls = [
      ['GET', url(A, bConnectionId), undefined],
      ['PATCH', url(A, bConnectionId), { dailyBudgetUnits: 1 }],
      ['GET', url(A, bConnectionId, '/quota'), undefined],
      ['GET', url({ ...A, brandId: B.brandId }, bConnectionId), undefined],
      ['GET', url(sameOrgOtherBrand, connectionId), undefined],
      ['PATCH', url(sameOrgOtherBrand, connectionId), { dailyBudgetUnits: 1 }],
      ['GET', url(sameOrgOtherBrand, connectionId, '/quota'), undefined],
      ['GET', url(A, 'not-a-uuid'), undefined],
    ] as const;
    for (const [method, u, body] of calls) {
      const r = await api.req(method, u, { cookie: A.owner.cookie, body });
      expect(r.status, `${method} ${u}`).toBe(404);
      expect(r.body).toEqual(missing.body);
    }
    const b = await api.req('GET', url(B, bConnectionId), { cookie: B.owner.cookie });
    expect(b.body.settings.dailyBudgetUnits).toBe(2000);
  });

  it('a non-youtube connection is 404', async () => {
    const missing = await api.req('GET', url(A, '00000000-0000-4000-8000-000000000000'), {
      cookie: A.owner.cookie,
    });
    for (const [method, tail, body] of [
      ['GET', '', undefined],
      ['PATCH', '', { dryRun: true }],
      ['GET', '/quota', undefined],
    ] as const) {
      const r = await api.req(method, url(A, facebookId, tail), { cookie: A.owner.cookie, body });
      expect(r.status).toBe(404);
      expect(r.body).toEqual(missing.body);
    }
  });
});

describe('GET youtube quota ledger totals', () => {
  const quota = (q: string) =>
    api.req('GET', url(A, connectionId, `/quota${q}`), { cookie: A.owner.cookie });
  const dayKey = (offsetDays: number) => pacificDayKey(Date.now() + offsetDays * 86_400_000);

  it('returns real totals per method and purpose for a day', async () => {
    const day = dayKey(-1);
    await api.pool.query(
      `INSERT INTO youtube_quota_ledger (call_key, pacific_day, organization_id, brand_id, connection_id, method, purpose, units, simulated)
       VALUES ('q-1', $4::date, $1, $2, $3, 'commentThreads.list', 'read', 1, false),
              ('q-2', $4::date, $1, $2, $3, 'commentThreads.list', 'read', 1, false),
              ('q-3', $4::date, $1, $2, $3, 'comments.setModerationStatus', 'write', 50, true)`,
      [A.orgId, A.brandId, connectionId, day],
    );
    const r = await quota(`?day=${day}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      day,
      totals: [{ method: 'commentThreads.list', purpose: 'read', units: 2, calls: 2 }],
    });
  });

  it("defaults to today's Pacific day", async () => {
    const r = await quota('');
    expect(r.status).toBe(200);
    expect(r.body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects malformed, impossible and too-old days', async () => {
    for (const q of [
      '?day=../x',
      '?day=2026-13-40',
      '?day=2026-02-30',
      '?day=20260101',
      `?day=${dayKey(-91)}`,
      '?day=2026-01-01&day=2026-01-02',
      '?day=',
    ]) {
      const r = await quota(q);
      expect(r.status, q).toBe(400);
    }
    expect((await quota(`?day=${dayKey(-89)}`)).status).toBe(200);
  });
});
