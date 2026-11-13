// Onboarding step 4: GET /report and POST /report/complete, plus the whole happy path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';

let api: TestApi;
let users: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
let seq = 0;

beforeAll(async () => {
  api = await startTestApi();
  const first = await orgWithRoles(api, 'onbp');
  users = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(() => api.close());

const fresh = () => orgWithRoles(api, `onbp${++seq}`, users);
const url = (f: { orgId: string }, p = '') => `/api/v1/orgs/${f.orgId}/onboarding${p}`;
const call = (method: string, path: string, user: TestUser, body?: unknown) =>
  api.req(method, path, { cookie: user.cookie, ...(body !== undefined && { body }) });

async function connect(f: OrgFixture): Promise<string> {
  const { scope } = await api.seedConnection(f, {
    platform: 'facebook',
    externalAccountId: `p${++seq}`,
  });
  return scope.connectionId;
}

async function backfill(
  f: OrgFixture,
  connectionId: string,
  status: 'completed' | 'running',
  imported = 0,
) {
  await api.pool.query(
    `INSERT INTO connection_backfill (connection_id, organization_id, brand_id, run_id, status,
                                      window_start, window_end, max_comments, requested_at,
                                      heartbeat_at, imported_count)
     VALUES ($1, $2, $3, gen_random_uuid(), $4, now() - interval '90 days', now(), 1000, now(), now(), $5)`,
    [connectionId, f.orgId, f.brandId, status, imported],
  );
}

async function comments(f: OrgFixture, connectionId: string, n: number, brandId = f.brandId) {
  const s = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [f.orgId, brandId, connectionId, `8_${++seq}`],
  );
  for (let i = 0; i < n; i++)
    await api.pool.query(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at, ingest_origin)
       VALUES ($1, $2, $3, $4, $5, 'SECRET-BODY', now() - interval '1 day', 'backfill')`,
      [f.orgId, brandId, connectionId, s.rows[0].id, `8_${++seq}`],
    );
}

const report = (f: OrgFixture, user: TestUser = f.owner) => call('GET', url(f, '/report'), user);
const complete = (f: OrgFixture, user: TestUser = f.owner) =>
  call('POST', url(f, '/report/complete'), user, {});

/** Runs steps 1-3 (defaults unchanged, review mode as given). */
async function toStep4(f: OrgFixture, choice: 'review' | 'automatic' = 'review') {
  expect((await call('POST', url(f, '/start'), f.owner, {})).status).toBe(200);
  expect((await call('POST', url(f, '/connect/complete'), f.owner, {})).status).toBe(200);
  const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
  const d = await call('PUT', url(f, '/defaults'), f.owner, {
    choices: g.categories
      .filter((c: { action: string }) => c.action !== 'remove')
      .map((c: { category: string; action: string }) => ({
        category: c.category,
        action: c.action,
      })),
    basedOn: g.basedOn,
  });
  expect(d.status).toBe(200);
  const r = await call(
    'PUT',
    url(f, '/review-mode'),
    f.owner,
    choice === 'review' ? { choice } : { choice, acknowledgeRisk: true },
  );
  expect(r.status).toBe(200);
}

describe('GET /report', () => {
  it('empty account: completed backfill with 0 imported is empty and ready; complete succeeds', async () => {
    const f = await fresh();
    const id = await connect(f);
    await backfill(f, id, 'completed', 0);
    await toStep4(f);
    const r = await report(f);
    expect(r.status).toBe(200);
    expect(r.body.empty).toBe(true);
    expect(r.body.sync).toBe('ready');
    expect(r.body.totals.comments).toBe(0);
    expect(r.body.accounts).toHaveLength(1);
    expect(r.body.accounts[0]).toMatchObject({
      connectionId: id,
      platform: 'facebook',
      comments: 0,
      imported: 0,
      checked: 0,
      hidden: 0,
      awaitingReview: 0,
      status: 'connected',
    });
    expect(r.body.accounts[0].backfill).toMatchObject({ status: 'completed', importedCount: 0 });
    const range = r.body.range;
    const span = Date.parse(range.to) - Date.parse(range.from);
    expect(span).toBe(30 * 86_400_000);
    expect(Math.abs(Date.parse(range.to) - Date.now())).toBeLessThan(60_000);
    expect((await complete(f)).status).toBe(200);
  });

  it('running backfill is syncing and complete still succeeds', async () => {
    const f = await fresh();
    const id = await connect(f);
    await backfill(f, id, 'running', 0);
    await toStep4(f);
    expect((await report(f)).body.sync).toBe('syncing');
    const c = await complete(f);
    expect(c.status).toBe(200);
    expect(c.body.complete).toBe(true);
  });

  it('no connections is no_connections', async () => {
    const f = await fresh();
    const r = await report(f);
    expect(r.status).toBe(200);
    expect(r.body.sync).toBe('no_connections');
    expect(r.body.accounts).toEqual([]);
  });

  it('two connections give two entries with their own counts', async () => {
    const f = await fresh();
    const a = await connect(f);
    const b = await connect(f);
    await comments(f, a, 2);
    await comments(f, b, 3);
    await backfill(f, a, 'completed', 2);
    await backfill(f, b, 'completed', 3);
    const r = await report(f);
    expect(r.body.totals.comments).toBe(5);
    expect(r.body.empty).toBe(false);
    const by = new Map(r.body.accounts.map((x: { connectionId: string }) => [x.connectionId, x]));
    expect(by.get(a)).toMatchObject({ comments: 2, imported: 2 });
    expect(by.get(b)).toMatchObject({ comments: 3, imported: 3 });
  });

  it('comments on a second brand are excluded', async () => {
    const f = await fresh();
    const a = await connect(f);
    await comments(f, a, 1);
    const other = await api.pool.query(
      `INSERT INTO brand (organization_id, name) VALUES ($1, 'Other') RETURNING id`,
      [f.orgId],
    );
    const { scope } = await api.seedConnection(
      { orgId: f.orgId, brandId: other.rows[0].id },
      { platform: 'facebook', externalAccountId: `o${++seq}` },
    );
    await comments(f, scope.connectionId, 4, other.rows[0].id);
    const r = await report(f);
    expect(r.body.totals.comments).toBe(1);
    expect(r.body.accounts).toHaveLength(1);
    expect(r.body.accounts[0].connectionId).toBe(a);
  });

  it('echoes the review-mode choice and the defaults saved by steps 2-3, without comment text', async () => {
    const f = await fresh();
    const a = await connect(f);
    await comments(f, a, 1);
    await call('POST', url(f, '/start'), f.owner, {});
    await call('POST', url(f, '/connect/complete'), f.owner, {});
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const live = g.categories.filter((c: { action: string }) => c.action !== 'remove');
    const first = live[0];
    const flipped = first.action === 'flag' ? 'hide' : 'flag';
    const choices = live.map((c: { category: string; action: string }) => ({
      category: c.category,
      action: c === first ? flipped : c.action,
    }));
    expect(
      (await call('PUT', url(f, '/defaults'), f.owner, { choices, basedOn: g.basedOn })).status,
    ).toBe(200);
    await call('PUT', url(f, '/review-mode'), f.owner, { choice: 'review' });
    const r = await report(f);
    expect(r.body.reviewModeChoice).toBe('review');
    expect(r.body.defaults).toEqual(choices);
    expect(JSON.stringify(r.body)).not.toContain('SECRET-BODY');
    expect(r.body.notableThreads).toBeUndefined();
  });

  it('is open to org.update only', async () => {
    const f = await fresh();
    expect((await report(f, f.member)).status).toBe(403);
  });
});

describe('POST /report/complete', () => {
  it('is locked until the earlier steps are done', async () => {
    const f = await fresh();
    await connect(f);
    await call('POST', url(f, '/start'), f.owner, {});
    const r = await complete(f);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('onboarding_step_locked');
  });

  it('is idempotent and audits once', async () => {
    const f = await fresh();
    await connect(f);
    await toStep4(f);
    const one = await complete(f);
    const two = await complete(f);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    const n = await api.pool.query(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE organization_id = $1 AND action = 'onboarding.step_completed' AND details->>'step' = 'report'`,
      [f.orgId],
    );
    expect(n.rows[0].n).toBe(1);
    const row = await api.pool.query(
      'SELECT completed_at FROM onboarding_state WHERE organization_id = $1',
      [f.orgId],
    );
    expect(row.rows[0].completed_at).not.toBeNull();
  });

  it('rejects a non-empty body and members', async () => {
    const f = await fresh();
    expect((await call('POST', url(f, '/report/complete'), f.owner, { x: 1 })).status).toBe(400);
    expect((await complete(f, f.member)).status).toBe(403);
  });
});

describe('happy path', () => {
  it('start, connect, defaults, review mode, report, complete', async () => {
    const f = await fresh();
    const id = await connect(f);
    await backfill(f, id, 'completed', 3);
    await comments(f, id, 3);
    await toStep4(f);
    const r = await report(f);
    expect(r.body.totals.comments).toBe(3);
    const done = await complete(f);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ complete: true, resumeStep: null, autoStart: false });
    const again = await call('GET', url(f), f.owner);
    expect(again.body).toMatchObject({ complete: true, resumeStep: null, autoStart: false });
  });
});
