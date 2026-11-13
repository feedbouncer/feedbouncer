// Onboarding state over the API: read, start, brand, connect/complete, dismiss, rerun.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';

let api: TestApi;
let users: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
let seq = 0;

beforeAll(async () => {
  api = await startTestApi();
  const first = await orgWithRoles(api, 'onb');
  users = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(() => api.close());

const fresh = () => orgWithRoles(api, `onb${++seq}`, users);
const url = (f: { orgId: string }, p = '') => `/api/v1/orgs/${f.orgId}/onboarding${p}`;
const call = (method: string, path: string, user: TestUser, body?: unknown) =>
  api.req(method, path, { cookie: user.cookie, ...(body !== undefined && { body }) });
const count = async (orgId: string) =>
  Number(
    (
      await api.pool.query(
        'SELECT count(*)::int AS n FROM onboarding_state WHERE organization_id = $1',
        [orgId],
      )
    ).rows[0].n,
  );
const audits = async (orgId: string, action: string) =>
  Number(
    (
      await api.pool.query(
        'SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1 AND action = $2',
        [orgId, action],
      )
    ).rows[0].n,
  );

describe('read', () => {
  it('fresh org: not started, autoStart, resume at connect, defaults unreachable', async () => {
    const f = await fresh();
    const r = await call('GET', url(f), f.owner);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      started: false,
      autoStart: true,
      preconfigured: false,
      dismissed: false,
      complete: false,
      run: 1,
      resumeStep: 'connect',
      brand: { id: f.brandId },
      connections: [],
      configuredPlatforms: [],
      reviewModeChoice: null,
    });
    expect(r.body.brands).toHaveLength(1);
    expect(r.body.reachable).toEqual({
      connect: true,
      defaults: false,
      review_mode: false,
      report: false,
    });
  });

  it('GET never creates a row', async () => {
    const f = await fresh();
    await call('GET', url(f), f.owner);
    await call('GET', url(f), f.admin);
    expect(await count(f.orgId)).toBe(0);
  });

  it('an org with a classifier_threshold row is preconfigured', async () => {
    const f = await fresh();
    await api.pool.query(
      `INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action)
       VALUES ($1, $2, 'spam', 0.9, 'hide')`,
      [f.orgId, f.brandId],
    );
    const r = await call('GET', url(f), f.owner);
    expect(r.body).toMatchObject({ preconfigured: true, autoStart: false });
  });

  it('an org with an active connection is preconfigured', async () => {
    const f = await fresh();
    await api.seedConnection(f, { platform: 'facebook', externalAccountId: `pc${seq}` });
    const r = await call('GET', url(f), f.owner);
    expect(r.body).toMatchObject({ preconfigured: true, autoStart: false });
  });

  it('a rule-only org is preconfigured', async () => {
    const f = await fresh();
    await api.pool.query(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action)
       VALUES ($1, $2, 'r', '{}'::jsonb, 'hide')`,
      [f.orgId, f.brandId],
    );
    const r = await call('GET', url(f), f.owner);
    expect(r.body).toMatchObject({ preconfigured: true, autoStart: false });
  });

  it('an org whose only rule is archived is not preconfigured', async () => {
    const f = await fresh();
    await api.pool.query(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action, archived_at)
       VALUES ($1, $2, 'r', '{}'::jsonb, 'hide', now())`,
      [f.orgId, f.brandId],
    );
    const r = await call('GET', url(f), f.owner);
    expect(r.body).toMatchObject({ preconfigured: false, autoStart: true });
  });

  it.each([
    ['reconnect_required', null, true],
    ['paused', null, true],
    ['reconnect_required', 'oauth_pending', false],
  ])('an org with only a %s (%s) connection: preconfigured=%s', async (status, reason, want) => {
    const f = await fresh();
    await api.pool.query(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, status_reason)
       VALUES ($1, $2, 'facebook', $3, $4, $5)`,
      [f.orgId, f.brandId, `st${seq}`, status, reason],
    );
    const r = await call('GET', url(f), f.owner);
    expect(r.body).toMatchObject({ preconfigured: want, autoStart: !want });
  });

  it('autoStart is only for managers, and only while no wizard row exists', async () => {
    const f = await fresh();
    expect((await call('GET', url(f), f.member)).status).toBe(403);
    expect((await call('GET', url(f), f.admin)).body.autoStart).toBe(true);
    await call('POST', url(f, '/start'), f.owner, {});
    const r = await call('GET', url(f), f.owner);
    expect(r.body).toMatchObject({ started: true, autoStart: false });
  });

  it('an org without a live brand has brand=null', async () => {
    const f = await fresh();
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [f.brandId]);
    const r = await call('GET', url(f), f.owner);
    expect(r.status).toBe(200);
    expect(r.body.brand).toBeNull();
    expect(r.body.brands).toEqual([]);
  });
});

describe('start', () => {
  it('is idempotent: one row, started_by the first caller, one audit', async () => {
    const f = await fresh();
    const a = await call('POST', url(f, '/start'), f.owner, {});
    const b = await call('POST', url(f, '/start'), f.admin, {});
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.started).toBe(true);
    expect(b.body.started).toBe(true);
    expect(await count(f.orgId)).toBe(1);
    const row = await api.pool.query(
      'SELECT started_by_user_id, brand_id, last_actor_user_id FROM onboarding_state WHERE organization_id = $1',
      [f.orgId],
    );
    expect(row.rows[0].started_by_user_id).toBe(f.owner.userId);
    expect(row.rows[0].brand_id).toBe(f.brandId);
    expect(row.rows[0].last_actor_user_id).toBe(f.admin.userId);
    expect(await audits(f.orgId, 'onboarding.started')).toBe(1);
  });
});

describe('brand', () => {
  it('switches to another live brand and persists it', async () => {
    const f = await fresh();
    const made = await call('POST', `/api/v1/orgs/${f.orgId}/brands`, f.owner, {
      name: 'Second',
      timezone: 'UTC',
    });
    expect(made.status).toBe(201);
    const id = made.body.brand.id as string;
    const r = await call('PUT', url(f, '/brand'), f.owner, { brandId: id });
    expect(r.status).toBe(200);
    expect(r.body.brand).toEqual({ id, name: 'Second' });
    const again = await call('GET', url(f), f.owner);
    expect(again.body.brand.id).toBe(id);
  });

  it("another org's brand is 404", async () => {
    const f = await fresh();
    const g = await fresh();
    const r = await call('PUT', url(f, '/brand'), f.owner, { brandId: g.brandId });
    expect(r.status).toBe(404);
  });

  it('an archived target falls back to the other live brand and keeps statuses', async () => {
    const f = await fresh();
    const made = await call('POST', `/api/v1/orgs/${f.orgId}/brands`, f.owner, {
      name: 'Other',
      timezone: 'UTC',
    });
    const other = made.body.brand.id as string;
    await api.seedConnection(f, { platform: 'facebook', externalAccountId: `ar${seq}` });
    await call('POST', url(f, '/start'), f.owner, {});
    expect((await call('POST', url(f, '/connect/complete'), f.owner, {})).status).toBe(200);
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [f.brandId]);
    const r = await call('GET', url(f), f.owner);
    expect(r.body.brand.id).toBe(other);
    expect(r.body.steps.connect).toBe('done');
    const dismissed = await call('POST', url(f, '/dismiss'), f.owner, {});
    expect(dismissed.body.brand.id).toBe(other);
    const row = await api.pool.query(
      'SELECT brand_id FROM onboarding_state WHERE organization_id = $1',
      [f.orgId],
    );
    expect(row.rows[0].brand_id).toBe(other);
  });
});

describe('connect/complete', () => {
  it('409 onboarding_no_working_connection without a connection', async () => {
    const f = await fresh();
    const r = await call('POST', url(f, '/connect/complete'), f.owner, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('onboarding_no_working_connection');
    expect(r.body.error.message).toBe(
      "Connect at least one account that's working before you continue.",
    );
  });

  it('409 onboarding_no_brand without a live brand', async () => {
    const f = await fresh();
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [f.brandId]);
    const r = await call('POST', url(f, '/connect/complete'), f.owner, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('onboarding_no_brand');
  });

  it('succeeds with one connected and one failed connection', async () => {
    const f = await fresh();
    await api.seedConnection(f, { platform: 'facebook', externalAccountId: `ok${seq}` });
    const bad = await api.seedConnection(f, {
      platform: 'facebook',
      externalAccountId: `bad${seq}`,
    });
    await api.pool.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_refresh_rejected' WHERE id = $1",
      [bad.scope.connectionId],
    );
    const r = await call('POST', url(f, '/connect/complete'), f.owner, {});
    expect(r.status).toBe(200);
    expect(r.body.resumeStep).toBe('defaults');
    expect(r.body.steps.connect).toBe('done');
    expect(r.body.reachable.defaults).toBe(true);
    expect(r.body.connections.map((c: { status: string }) => c.status).sort()).toEqual([
      'connected',
      'failed',
    ]);
    expect(await audits(f.orgId, 'onboarding.step_completed')).toBe(1);
    await call('POST', url(f, '/connect/complete'), f.owner, {});
    expect(await audits(f.orgId, 'onboarding.step_completed')).toBe(1);
  });

  it('resumes at defaults after a restart', async () => {
    const f = await fresh();
    await api.seedConnection(f, { platform: 'facebook', externalAccountId: `rs${seq}` });
    await call('POST', url(f, '/connect/complete'), f.owner, {});
    const api2 = await startTestApi({ databaseUrl: api.deps.env.databaseUrl });
    try {
      const r = await api2.req('GET', url(f), { cookie: f.owner.cookie });
      expect(r.status).toBe(200);
      expect(r.body.resumeStep).toBe('defaults');
      expect(r.body.steps.connect).toBe('done');
    } finally {
      await api2.close();
    }
  });

  it('a connection revoked mid-wizard shows as failed but connect stays done', async () => {
    const f = await fresh();
    const c = await api.seedConnection(f, { platform: 'facebook', externalAccountId: `rv${seq}` });
    await call('POST', url(f, '/connect/complete'), f.owner, {});
    await api.pool.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_refresh_rejected' WHERE id = $1",
      [c.scope.connectionId],
    );
    const r = await call('GET', url(f), f.owner);
    expect(r.body.steps.connect).toBe('done');
    expect(r.body.connections).toHaveLength(1);
    expect(r.body.connections[0]).toMatchObject({
      status: 'failed',
      statusReason: 'oauth_refresh_rejected',
      needsReconnect: true,
    });
  });

  it('needsReconnect follows the connection status, not the reason code', async () => {
    const f = await fresh();
    const a = await api.seedConnection(f, { platform: 'facebook', externalAccountId: `nr${seq}a` });
    const b = await api.seedConnection(f, { platform: 'facebook', externalAccountId: `nr${seq}b` });
    await api.pool.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'page_role_lost' WHERE id = $1",
      [a.scope.connectionId],
    );
    await api.pool.query(
      "UPDATE connection SET status = 'error', status_reason = 'credential_decrypt_failed' WHERE id = $1",
      [b.scope.connectionId],
    );
    const r = await call('GET', url(f), f.owner);
    const byId = new Map(r.body.connections.map((c: { id: string }) => [c.id, c]));
    expect(byId.get(a.scope.connectionId)).toMatchObject({
      status: 'failed',
      needsReconnect: true,
    });
    expect(byId.get(b.scope.connectionId)).toMatchObject({
      status: 'failed',
      needsReconnect: false,
    });
  });
});

describe('dismiss and rerun', () => {
  it('dismiss stops autoStart and leaves settings untouched', async () => {
    const f = await fresh();
    const r = await call('POST', url(f, '/dismiss'), f.owner, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dismissed: true, autoStart: false });
    expect(await audits(f.orgId, 'onboarding.dismissed')).toBe(1);
    await call('POST', url(f, '/dismiss'), f.owner, {});
    expect(await audits(f.orgId, 'onboarding.dismissed')).toBe(1);
  });

  it('rerun without confirm is 422', async () => {
    const f = await fresh();
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }, { confirm: true, extra: 1 }]) {
      const r = await call('POST', url(f, '/rerun'), f.owner, body);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('onboarding_rerun_unconfirmed');
      expect(r.body.error.message).toBe('Confirm that you want to run setup again.');
    }
  });

  it('rerun with confirm resets steps and leaves settings byte-identical', async () => {
    const f = await fresh();
    await api.pool.query(
      `INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action)
       VALUES ($1, $2, 'spam', 0.9, 'hide')`,
      [f.orgId, f.brandId],
    );
    await api.seedConnection(f, { platform: 'facebook', externalAccountId: `rr${seq}` });
    await call('POST', url(f, '/connect/complete'), f.owner, {});
    await call('POST', url(f, '/dismiss'), f.owner, {});
    const snap = async () =>
      JSON.stringify([
        (
          await api.pool.query(
            'SELECT * FROM classifier_threshold WHERE organization_id = $1 ORDER BY id',
            [f.orgId],
          )
        ).rows,
        (
          await api.pool.query(
            'SELECT review_mode, review_mode_started_at, review_mode_ends_at, review_mode_ended_at FROM connection WHERE organization_id = $1 ORDER BY id',
            [f.orgId],
          )
        ).rows,
      ]);
    const before = await snap();
    const r = await call('POST', url(f, '/rerun'), f.owner, { confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      run: 2,
      dismissed: false,
      complete: false,
      resumeStep: 'connect',
    });
    expect(r.body.steps).toEqual({
      connect: 'pending',
      defaults: 'pending',
      review_mode: 'pending',
      report: 'pending',
    });
    expect(await snap()).toBe(before);
    expect(await audits(f.orgId, 'onboarding.rerun')).toBe(1);
  });
});

describe('authorization and tenancy', () => {
  it('a member gets 403 on every route', async () => {
    const f = await fresh();
    const routes: [string, string, unknown?][] = [
      ['GET', url(f)],
      ['POST', url(f, '/start'), {}],
      ['PUT', url(f, '/brand'), { brandId: f.brandId }],
      ['POST', url(f, '/connect/complete'), {}],
      ['POST', url(f, '/dismiss'), {}],
      ['POST', url(f, '/rerun'), { confirm: true }],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, f.member, b)).status, `${m} ${p}`).toBe(403);
    }
  });

  it("an admin of another org gets 404 on this org's routes", async () => {
    const f = await fresh();
    const outsider = await verifiedUser(api, 'onb-outsider');
    const routes: [string, string, unknown?][] = [
      ['GET', url(f)],
      ['POST', url(f, '/start'), {}],
      ['PUT', url(f, '/brand'), { brandId: f.brandId }],
      ['POST', url(f, '/connect/complete'), {}],
      ['POST', url(f, '/dismiss'), {}],
      ['POST', url(f, '/rerun'), { confirm: true }],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, outsider, b)).status, `${m} ${p}`).toBe(404);
    }
    expect(await count(f.orgId)).toBe(0);
  });
});
