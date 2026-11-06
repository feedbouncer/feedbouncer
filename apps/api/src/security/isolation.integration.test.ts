import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { FakeThreads } from '@feedbouncer/connector-threads/testing';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import { startTestApi, type TestApi } from '../testing/harness.js';
import { buildIsolationFixture } from './isolation-fixture.js';
import { CASES, PICKER_PLATFORMS, TOKEN_CASES, type IsolationFixture } from './isolation-cases.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

const TIKTOK = { appId: '7300000000000001', appSecret: 'tiktok-app-secret-0123456789' };

const TIKTOK_CFG = { ...TIKTOK, appSecret: new Secret(TIKTOK.appSecret) };

const THREADS = { appId: '2220001112223334', appSecret: 'threads-app-secret-0123456789' };
const THREADS_CFG = {
  appId: THREADS.appId,
  appSecret: new Secret(THREADS.appSecret),
  webhookVerifyToken: null,
  pollIntervalSec: 600,
  discoveryIntervalSec: 900,
};

let api: TestApi;
let f: IsolationFixture;
/** Every TikTok request the app makes; no case may make one. */
const tiktok = new FakeTikTok(TIKTOK);
/** Every Threads request the app makes; no case may make one either. */
const threads = new FakeThreads(THREADS);
const fetchAny: typeof globalThis.fetch = (input, init) =>
  new URL(input instanceof Request ? input.url : String(input)).hostname.endsWith('threads.net')
    ? threads.fetch(input, init)
    : tiktok.fetch(input, init);
beforeAll(async () => {
  api = await startTestApi(
    {
      facebook: FACEBOOK,
      instagram: { meta: FACEBOOK },
      tiktok: TIKTOK_CFG,
      tiktokAds: TIKTOK_CFG,
      threads: THREADS_CFG,
      alerts: { slack: true, email: true, capPerHour: 30, emailPerMinute: 60 },
    },
    { fetch: fetchAny },
  );
  f = await buildIsolationFixture(api);
});
afterAll(() => api.close());

// Everything a request could change about an organization, including invitation
// token hashes (a renewal rotates them) and the audit trail (any write appends).
async function snapshot(orgId: string) {
  const q = (sql: string) => api.pool.query(sql, [orgId]).then((r) => r.rows);
  return {
    org: await q('SELECT name FROM organization WHERE id = $1'),
    brands: await q(
      'SELECT id, name, archived_at FROM brand WHERE organization_id = $1 ORDER BY id',
    ),
    roleGrants: await q(
      'SELECT role, capability FROM role_grant WHERE organization_id = $1 ORDER BY role, capability',
    ),
    members: await q(
      'SELECT user_id, role FROM membership WHERE organization_id = $1 ORDER BY user_id',
    ),
    invitations: await q(
      `SELECT id, email, role, status, token_hash, expires_at FROM invitation
       WHERE organization_id = $1 ORDER BY id`,
    ),
    connectionSync: await q(
      `SELECT connection_id, last_success_at, consecutive_failures FROM connection_sync
       WHERE organization_id = $1 ORDER BY connection_id`,
    ),
    connections: await q(
      `SELECT id, status, status_reason, review_mode, review_mode_ended_at FROM connection
       WHERE organization_id = $1 ORDER BY id`,
    ),
    comments: await q(
      'SELECT id, platform_state FROM comment WHERE organization_id = $1 ORDER BY id',
    ),
    actions: await q(
      'SELECT id, status FROM moderation_action WHERE organization_id = $1 ORDER BY id',
    ),
    actionSteps: await q(
      'SELECT id, status, undone_at FROM action_run_step WHERE organization_id = $1 ORDER BY id',
    ),
    reviewItems: await q(
      'SELECT id, status, resolution FROM review_item WHERE organization_id = $1 ORDER BY id',
    ),
    suggestions: await q(
      'SELECT id, status, decided_at FROM action_suggestion WHERE organization_id = $1 ORDER BY id',
    ),
    rules: await q(
      `SELECT id, name, conditions, action, mode, enabled, priority, archived_at FROM rule
       WHERE organization_id = $1 ORDER BY id`,
    ),
    apiKeys: await q(
      'SELECT id, name, revoked_at FROM api_key WHERE organization_id = $1 ORDER BY id',
    ),
    ruleChanges: await q(
      'SELECT id, status, decided_at FROM rule_change_proposal WHERE organization_id = $1 ORDER BY id',
    ),
    domains: await q('SELECT id, domain FROM brand_domain WHERE organization_id = $1 ORDER BY id'),
    grants: await q('SELECT id FROM oauth_grant WHERE organization_id = $1 ORDER BY id'),
    classifierRuns: await q(
      'SELECT id, days, since FROM classifier_run WHERE organization_id = $1 ORDER BY id',
    ),
    thresholds: await q(
      `SELECT brand_id, category, threshold::text, action, updated_by_user_id FROM classifier_threshold
       WHERE organization_id = $1 ORDER BY brand_id, category`,
    ),
    classifications: await q(
      'SELECT id, status FROM comment_classification WHERE organization_id = $1 ORDER BY id',
    ),
    tags: await q('SELECT id, name FROM tag WHERE organization_id = $1 ORDER BY id'),
    commentTags: await q(
      'SELECT comment_id, tag_id FROM comment_tag WHERE organization_id = $1 ORDER BY comment_id, tag_id',
    ),
    commentDone: await q(
      'SELECT comment_id FROM comment_done WHERE organization_id = $1 ORDER BY comment_id',
    ),
    alertChannels: await q(
      `SELECT id, kind, label, status, webhook_hint, encrypted_webhook_url, consecutive_failures, updated_at
         FROM alert_channel WHERE organization_id = $1 ORDER BY id`,
    ),
    alertSettings: await q(
      `SELECT brand_id, sensitivity, min_negative_count, cooldown_minutes, content_mode
         FROM alert_brand_settings WHERE organization_id = $1 ORDER BY brand_id`,
    ),
    alertRoutes: await q(
      `SELECT brand_id, alert_type, channel_id, enabled FROM alert_route
        WHERE organization_id = $1 ORDER BY brand_id, alert_type, channel_id`,
    ),
    jobs: await q('SELECT id, state FROM job_ledger WHERE organization_id = $1 ORDER BY id'),
    audit: await q(
      `SELECT sequence, action, subject_type, subject_id, actor_user_id FROM audit_event
       WHERE organization_id = $1 ORDER BY sequence`,
    ),
  };
}

describe('A owner cannot reach B', () => {
  for (const c of CASES) {
    it(`${c.name} -> 404`, async () => {
      const beforeB = await snapshot(f.B.orgId);
      const beforeA = await snapshot(f.A.orgId);
      expect(beforeB.invitations.length).toBeGreaterThan(0);
      expect(beforeB.audit.length).toBeGreaterThan(0);
      expect(beforeB.grants).toHaveLength(PICKER_PLATFORMS.length);
      expect(beforeB.tags).toHaveLength(1);
      expect(beforeB.alertChannels).toHaveLength(1);
      expect(beforeB.alertRoutes).toHaveLength(1);
      const [method] = c.route.split(' ');
      const r = await api.req(method!, c.url(f), { cookie: f.A.owner.cookie, body: c.body?.(f) });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
      expect(await snapshot(f.B.orgId)).toEqual(beforeB);
      expect(await snapshot(f.A.orgId)).toEqual(beforeA);
      expect(tiktok.calls()).toEqual([]);
      expect(threads.calls()).toEqual([]);
    });
  }
});

describe("A owner holding B's invitation token", () => {
  for (const c of TOKEN_CASES) {
    it(`${c.name} -> ${c.status}, nothing more`, async () => {
      const beforeB = await snapshot(f.B.orgId);
      const beforeA = await snapshot(f.A.orgId);
      expect(beforeB.invitations.map((i) => i.status)).toEqual(['pending']);
      const [method, url] = c.route.split(' ');
      const r = await api.req(method!, url!, { cookie: f.A.owner.cookie, body: c.body(f) });
      expect(r.status).toBe(c.status);
      expect(r.body).toEqual(c.response);
      expect(await snapshot(f.B.orgId)).toEqual(beforeB);
      expect(await snapshot(f.A.orgId)).toEqual(beforeA);
    });
  }
});

describe('without a session', () => {
  for (const c of TOKEN_CASES) {
    it(`${c.name} -> 401`, async () => {
      const [method, url] = c.route.split(' ');
      const r = await api.req(method!, url!, { body: c.body(f) });
      expect(r.status).toBe(401);
    });
  }
  for (const c of CASES) {
    it(`${c.name} -> 401`, async () => {
      const [method] = c.route.split(' ');
      const r = await api.req(method!, c.url(f), { body: c.body?.(f) });
      expect(r.status).toBe(401);
    });
  }
});

describe('backfill status', () => {
  it('never crosses organizations', async () => {
    await api.pool.query(
      `INSERT INTO connection_backfill
         (connection_id, organization_id, brand_id, run_id, status, window_start, window_end)
       VALUES ($1, $2, $3, gen_random_uuid(), 'running', now() - interval '1 day', now())`,
      [f.bConnectionId, f.B.orgId, f.B.brandId],
    );
    const own = await api.req(
      'GET',
      `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/connections`,
      {
        cookie: f.A.owner.cookie,
      },
    );
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(f.bConnectionId);
    const cross = await api.req(
      'GET',
      `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/connections`,
      {
        cookie: f.A.owner.cookie,
      },
    );
    expect(cross.status).toBe(404);
  });
});

describe("B's Threads comment id in A's own action log", () => {
  it('lists nothing of B', async () => {
    const r = await api.req(
      'GET',
      `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/action-log?commentId=${f.bThreadsCommentId}`,
      { cookie: f.A.owner.cookie },
    );
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    // The step exists: B's own owner sees it.
    const own = await api.req(
      'GET',
      `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/action-log?commentId=${f.bThreadsCommentId}`,
      { cookie: f.B.owner.cookie },
    );
    expect(own.body.items.map((i: { id: string }) => i.id)).toEqual([f.bThreadsStepId]);
  });
});

describe("B's ad id in A's own comments URL", () => {
  it('is ignored and leaks nothing of B', async () => {
    const r = await api.req('GET', `/api/v1/orgs/${f.A.orgId}/comments?ad=${f.bAdId}`, {
      cookie: f.A.owner.cookie,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied.ad).toBeNull();
    const text = JSON.stringify(r.body);
    for (const id of [f.bAdId, f.bCommentId, f.bConnectionId]) expect(text).not.toContain(id);
  });
});
