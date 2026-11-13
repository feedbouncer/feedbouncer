// Onboarding step 3: PUT /review-mode.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgSuggestionStore } from '@feedbouncer/actions';
import { Secret } from '@feedbouncer/service-runtime';
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
  const first = await orgWithRoles(api, 'onbr');
  users = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(() => api.close());

const fresh = () => orgWithRoles(api, `onbr${++seq}`, users);
const url = (f: { orgId: string }, p = '') => `/api/v1/orgs/${f.orgId}/onboarding${p}`;
const call = (method: string, path: string, user: TestUser, body?: unknown) =>
  api.req(method, path, { cookie: user.cookie, ...(body !== undefined && { body }) });
const put = (f: OrgFixture, body: unknown, user: TestUser = f.owner) =>
  call('PUT', url(f, '/review-mode'), user, body);

/** An active connection whose review window started an hour ago. */
async function reviewConnection(f: OrgFixture): Promise<string> {
  const { scope } = await api.seedConnection(f, {
    platform: 'facebook',
    externalAccountId: `r${++seq}`,
  });
  await api.pool.query(
    `UPDATE connection SET review_mode = 'on', review_mode_started_at = now() - interval '1 hour',
            review_mode_ends_at = now() - interval '1 hour' + interval '168 hours'
      WHERE id = $1`,
    [scope.connectionId],
  );
  return scope.connectionId;
}

/** Connect and defaults steps done, with one review-mode connection. */
async function atStep3() {
  const f = await fresh();
  const id = await reviewConnection(f);
  await call('POST', url(f, '/start'), f.owner, {});
  expect((await call('POST', url(f, '/connect/complete'), f.owner, {})).status).toBe(200);
  const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
  const d = await call('PUT', url(f, '/defaults'), f.owner, {
    choices: g.categories.map((c: { category: string; action: string }) => ({
      category: c.category,
      action: c.action,
    })),
    basedOn: g.basedOn,
  });
  expect(d.status).toBe(200);
  return { f, id };
}

async function suggest(f: OrgFixture, connectionId: string): Promise<string> {
  const n = ++seq;
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [f.orgId, f.brandId, connectionId, `9_${n}`],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, 'body', now()) RETURNING id`,
    [f.orgId, f.brandId, connectionId, source.rows[0].id, `9_${n}_1`],
  );
  const r = await new PgSuggestionStore(api.pool).propose(
    { organizationId: f.orgId, brandId: f.brandId, connectionId },
    {
      commentId: comment.rows[0].id,
      source: { type: 'classifier', ref: randomUUID() },
      steps: [{ type: 'hide' }],
      reason: 'spam',
    },
  );
  if (!('suggestionId' in r)) throw new Error('not proposed');
  return r.suggestionId;
}

const conn = async (id: string) =>
  (
    await api.pool.query(
      `SELECT review_mode, review_mode_started_at, review_mode_ends_at, review_mode_ended_at
         FROM connection WHERE id = $1`,
      [id],
    )
  ).rows[0];
const audits = async (orgId: string, action: string) =>
  Number(
    (
      await api.pool.query(
        'SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1 AND action = $2',
        [orgId, action],
      )
    ).rows[0].n,
  );

describe('PUT /review-mode', () => {
  it('automatic reports an active connection with no started window as skipped', async () => {
    const { f, id } = await atStep3();
    const { scope } = await api.seedConnection(f, {
      platform: 'facebook',
      externalAccountId: `u${++seq}`,
    });
    await api.pool.query(
      `UPDATE connection SET review_mode = 'on', review_mode_started_at = NULL,
              review_mode_ends_at = NULL WHERE id = $1`,
      [scope.connectionId],
    );
    const r = await put(f, { choice: 'automatic', acknowledgeRisk: true });
    expect(r.status).toBe(200);
    const a = await api.pool.query(
      `SELECT details FROM audit_event WHERE organization_id = $1 AND action = 'onboarding.review_mode_chosen'`,
      [f.orgId],
    );
    expect(a.rows[0].details).toEqual({
      choice: 'automatic',
      endedConnectionIds: id,
      skippedConnectionIds: scope.connectionId,
    });
    expect((await conn(scope.connectionId)).review_mode_ended_at).toBeNull();
  });

  it('review then automatic after the step is done ends the active connections, audits once more', async () => {
    const { f, id } = await atStep3();
    expect((await put(f, { choice: 'review' })).status).toBe(200);
    const r = await put(f, { choice: 'automatic', acknowledgeRisk: true });
    expect(r.status).toBe(200);
    expect(r.body.reviewModeChoice).toBe('automatic');
    expect((await conn(id)).review_mode_ended_at).not.toBeNull();
    expect(await audits(f.orgId, 'review_mode.ended_early')).toBe(1);
    expect(await audits(f.orgId, 'onboarding.review_mode_chosen')).toBe(2);
  });

  it("automatic in one org does not end another org's active connections", async () => {
    const a = await atStep3();
    const b = await atStep3();
    expect((await put(a.f, { choice: 'automatic', acknowledgeRisk: true })).status).toBe(200);
    expect((await conn(a.id)).review_mode_ended_at).not.toBeNull();
    expect((await conn(b.id)).review_mode_ended_at).toBeNull();
    expect(await audits(b.f.orgId, 'review_mode.ended_early')).toBe(0);
  });

  it("review leaves review_mode='on' and window columns unchanged", async () => {
    const { f, id } = await atStep3();
    const before = await conn(id);
    const r = await put(f, { choice: 'review' });
    expect(r.status).toBe(200);
    expect(r.body.steps.review_mode).toBe('done');
    expect(r.body.reviewModeChoice).toBe('review');
    expect(await conn(id)).toEqual(before);
    expect(before.review_mode).toBe('on');
    expect(await audits(f.orgId, 'onboarding.review_mode_chosen')).toBe(1);
    expect(await audits(f.orgId, 'review_mode.ended_early')).toBe(0);
  });

  it('automatic without acknowledgeRisk -> 422 risk_not_acknowledged', async () => {
    const { f, id } = await atStep3();
    for (const body of [{ choice: 'automatic' }, { choice: 'automatic', acknowledgeRisk: false }]) {
      const r = await put(f, body);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('risk_not_acknowledged');
    }
    expect((await conn(id)).review_mode_ended_at).toBeNull();
    expect((await put(f, { choice: 'nope' })).status).toBe(400);
  });

  it("automatic ends active connections; pending action_suggestion rows stay 'pending'", async () => {
    const { f, id } = await atStep3();
    const s = await suggest(f, id);
    const r = await put(f, { choice: 'automatic', acknowledgeRisk: true });
    expect(r.status).toBe(200);
    expect(r.body.reviewModeChoice).toBe('automatic');
    expect(r.body.steps.review_mode).toBe('done');
    expect((await conn(id)).review_mode_ended_at).not.toBeNull();
    const sg = await api.pool.query('SELECT status FROM action_suggestion WHERE id = $1', [s]);
    expect(sg.rows[0].status).toBe('pending');
    const a = await api.pool.query(
      `SELECT details FROM audit_event WHERE organization_id = $1 AND action = 'onboarding.review_mode_chosen'`,
      [f.orgId],
    );
    expect(a.rows[0].details).toEqual({
      choice: 'automatic',
      endedConnectionIds: id,
      skippedConnectionIds: '',
    });
    expect(await audits(f.orgId, 'review_mode.ended_early')).toBe(1);
  });

  it('automatic retried -> no second end call, no extra audit', async () => {
    const { f } = await atStep3();
    const body = { choice: 'automatic', acknowledgeRisk: true };
    expect((await put(f, body)).status).toBe(200);
    expect((await put(f, body)).status).toBe(200);
    expect(await audits(f.orgId, 'review_mode.ended_early')).toBe(1);
    expect(await audits(f.orgId, 'onboarding.review_mode_chosen')).toBe(1);
  });

  it('review after everything is ended -> 409 onboarding_step_locked', async () => {
    const { f } = await atStep3();
    await put(f, { choice: 'automatic', acknowledgeRisk: true });
    const r = await put(f, { choice: 'review' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('onboarding_step_locked');
  });

  it('step locked before defaults is done -> 409', async () => {
    const f = await fresh();
    await reviewConnection(f);
    await call('POST', url(f, '/start'), f.owner, {});
    const r = await put(f, { choice: 'review' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('onboarding_step_locked');
  });

  it('automatic is refused for a member', async () => {
    const { f, id } = await atStep3();
    expect((await put(f, { choice: 'automatic', acknowledgeRisk: true }, f.member)).status).toBe(
      403,
    );
    expect((await conn(id)).review_mode_ended_at).toBeNull();
  });

  it('dismissing the wizard at step 3 leaves every connection in review mode', async () => {
    const { f, id } = await atStep3();
    const r = await call('POST', url(f, '/dismiss'), f.owner, {});
    expect(r.status).toBe(200);
    expect(r.body.steps.review_mode).toBe('pending');
    const c = await conn(id);
    expect(c.review_mode).toBe('on');
    expect(c.review_mode_ended_at).toBeNull();
  });
});

describe('lock order with the review-mode end endpoint', () => {
  let fbApi: TestApi;
  beforeAll(async () => {
    const FACEBOOK = {
      appId: '1112223334',
      appSecret: new Secret('fb-app-secret-0123456789abcdef'),
      graphVersion: 'v26.0',
      webhookVerifyToken: new Secret('verify-token-0123456789'),
    };
    fbApi = await startTestApi({ facebook: FACEBOOK, instagram: { meta: FACEBOOK } });
  });
  afterAll(() => fbApi.close());

  it('ending review mode waits for the organization lock instead of deadlocking with a holder that then locks the connection', async () => {
    const f = await orgWithRoles(fbApi, `onbl${++seq}`);
    const { scope } = await fbApi.seedConnection(f, {
      platform: 'facebook',
      externalAccountId: `l${++seq}`,
    });
    const id = scope.connectionId;
    await fbApi.pool.query(
      `UPDATE connection SET review_mode = 'on', review_mode_started_at = now() - interval '1 hour',
              review_mode_ends_at = now() + interval '167 hours' WHERE id = $1`,
      [id],
    );
    const holder = await fbApi.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [f.orgId]);
      const ending = fbApi.req(
        'POST',
        `/api/v1/orgs/${f.orgId}/brands/${f.brandId}/connections/${id}/review-mode/end`,
        { cookie: f.owner.cookie, body: { pending: 'leave' } },
      );
      // Wait until the request is blocked on a lock (the organization row, or with the old order
      // the audit insert after it already held the connection row).
      for (let i = 0; i < 100; i++) {
        const w = await fbApi.pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1`,
          [(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid],
        );
        if (w.rowCount) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Same order as PUT /review-mode: the organization lock is already held, then the connection.
      await holder.query('SELECT 1 FROM connection WHERE id = $1 FOR UPDATE', [id]);
      await holder.query('COMMIT');
      const done = await ending;
      expect(done.body, JSON.stringify(done.body)).toMatchObject({ status: 'ended' });
    } finally {
      holder.release();
    }
    const ended = await fbApi.pool.query(
      'SELECT review_mode_ended_at FROM connection WHERE id = $1',
      [id],
    );
    expect(ended.rows[0].review_mode_ended_at).not.toBeNull();
  });
});
