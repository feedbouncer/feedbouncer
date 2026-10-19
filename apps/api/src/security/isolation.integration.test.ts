import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgOAuthGrantStore } from '@feedbouncer/connectors';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import { Secret } from '@feedbouncer/service-runtime';
import { PgAlertChannels } from '@feedbouncer/alerts';
import { PgApiKeys } from '@feedbouncer/public-api';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';
import { CASES, TOKEN_CASES, type IsolationFixture } from './isolation-cases.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

let api: TestApi;
let f: IsolationFixture;
beforeAll(async () => {
  api = await startTestApi({
    facebook: FACEBOOK,
    instagram: { meta: FACEBOOK },
    alerts: { slack: true, email: true, capPerHour: 30, emailPerMinute: 60 },
  });
  const A = await orgWithRoles(api, 'isoA');
  const B = await orgWithRoles(api, 'isoB');
  // Each org has a connection with sync state, so the snapshots prove read routes
  // do not write it. B's is a Facebook Page with one comment.
  const connectionIds: string[] = [];
  for (const o of [A, B]) {
    const fb = o === B;
    const { rows } = await api.pool.query(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
       VALUES ($1, $2, $3, $4, 'acct') RETURNING id`,
      [
        o.orgId,
        o.brandId,
        fb ? 'facebook' : 'youtube',
        fb ? `9${o.orgId.replace(/\D/g, '').slice(0, 15)}` : `ext-${o.orgId}`,
      ],
    );
    connectionIds.push(rows[0].id);
    await api.pool.query(
      `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at)
       VALUES ($1, $2, $3, now())`,
      [rows[0].id, o.orgId, o.brandId],
    );
  }
  const bConnectionId = connectionIds[1]!;
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', '1_2') RETURNING id`,
    [B.orgId, B.brandId, bConnectionId],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, '1_2_3', 'hi', now()) RETURNING id`,
    [B.orgId, B.brandId, bConnectionId, source.rows[0].id],
  );
  const bAd = await api.pool.query(
    `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
                          effective_status, active, facebook_source_external_id, facebook_resolution,
                          instagram_resolution, last_discovered_at)
     VALUES ($1, $2, $3, '555', '777', 'ACTIVE', true, '1_2', 'linked', 'not_instagram', now())
     RETURNING id`,
    [B.orgId, B.brandId, bConnectionId],
  );
  await api.pool.query(
    `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
     VALUES ($1, $2, $3, $4, 'facebook')`,
    [B.orgId, B.brandId, bAd.rows[0].id, source.rows[0].id],
  );
  const bRule = await api.pool.query(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, mode)
     VALUES ($1, $2, 'b rule', '{"type":"keyword","terms":["x"]}'::jsonb, 'flag', 'enforce') RETURNING id`,
    [B.orgId, B.brandId],
  );
  const bEvaluation = await api.pool.query(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                  trigger_key, ruleset_version, status)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'iso', 'v1', 'no_match') RETURNING id`,
    [B.orgId, B.brandId, bConnectionId, comment.rows[0].id],
  );
  const bRun = await api.pool.query(
    `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id,
                             rule_evaluation_id, dry_run)
     VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
    [
      B.orgId,
      B.brandId,
      bConnectionId,
      comment.rows[0].id,
      bRule.rows[0].id,
      bEvaluation.rows[0].id,
    ],
  );
  const bStep = await api.pool.query(
    `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status,
                                  completed_at)
     VALUES ($1, $2, $3, 0, 'flag_for_review', '{"type":"flag_for_review"}'::jsonb, 'succeeded', now())
     RETURNING id`,
    [B.orgId, B.brandId, bRun.rows[0].id],
  );
  const bHide = await api.pool.query(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                    actor_type, actor_user_id, request_key, status, completed_at)
     VALUES ($1, $2, $3, $4, 'hide', 'user', $5, 'iso-hide', 'applied', now()) RETURNING id`,
    [B.orgId, B.brandId, bConnectionId, comment.rows[0].id, B.owner.userId],
  );
  await api.pool.query("UPDATE comment SET platform_state = 'hidden' WHERE id = $1", [
    comment.rows[0].id,
  ]);
  const bReviewItem = await api.pool.query(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, rule_id)
     VALUES ($1, $2, $3, $4, 'action_step', $5) RETURNING id`,
    [B.orgId, B.brandId, bConnectionId, comment.rows[0].id, bRule.rows[0].id],
  );
  await api.pool.query(
    `UPDATE connection SET review_mode_started_at = now(), review_mode_ends_at = now() + interval '168 hours'
      WHERE id = $1`,
    [bConnectionId],
  );
  const bSuggestion = await api.pool.query(
    `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256)
     VALUES ($1, $2, $3, $4, sha256(convert_to('hi', 'UTF8'))) RETURNING id`,
    [B.orgId, B.brandId, bConnectionId, comment.rows[0].id],
  );
  await api.pool.query(
    `INSERT INTO action_suggestion_source (organization_id, brand_id, suggestion_id, source_type, source_ref,
                                           steps, reason)
     VALUES ($1, $2, $3, 'classifier', gen_random_uuid(), '[{"type":"hide"}]'::jsonb, 'spam')`,
    [B.orgId, B.brandId, bSuggestion.rows[0].id],
  );
  const aRule = await api.pool.query(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, mode)
     VALUES ($1, $2, 'a rule', '{"type":"keyword","terms":["x"]}'::jsonb, 'flag', 'enforce') RETURNING id`,
    [A.orgId, A.brandId],
  );
  const bDomain = await api.pool.query(
    `INSERT INTO brand_domain (organization_id, brand_id, domain) VALUES ($1, $2, 'b-own.example')
     RETURNING id`,
    [B.orgId, B.brandId],
  );
  const bClassifierRun = await api.pool.query(
    `INSERT INTO classifier_run (organization_id, brand_id, requested_by_user_id, days, since)
     VALUES ($1, $2, $3, 1, now() - interval '1 day') RETURNING id`,
    [B.orgId, B.brandId, B.owner.userId],
  );
  const bPolicy = await api.pool.query(
    `INSERT INTO custom_policy (organization_id, brand_id, name, created_by_user_id)
     VALUES ($1, $2, 'b policy', $3) RETURNING id`,
    [B.orgId, B.brandId, B.owner.userId],
  );
  await api.pool.query(
    `INSERT INTO custom_policy_revision (organization_id, brand_id, policy_id, revision, text, action, vague)
     VALUES ($1, $2, $3, 1, 'Flag comments asking for money', 'flag', false)`,
    [B.orgId, B.brandId, bPolicy.rows[0].id],
  );
  const bPreview = await api.pool.query(
    `INSERT INTO policy_preview (organization_id, brand_id, text, action, days, since, total, capped)
     VALUES ($1, $2, 'Flag comments asking for money', 'flag', 1, now() - interval '1 day', 0, false)
     RETURNING id`,
    [B.orgId, B.brandId],
  );
  await api.pool.query(
    `INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action, updated_by_user_id)
     VALUES ($1, $2, 'spam', 0.9, 'flag', $3)`,
    [B.orgId, B.brandId, B.owner.userId],
  );
  const igConnection = await api.pool.query(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
     VALUES ($1, $2, 'instagram', $3, 'ig acct') RETURNING id`,
    [B.orgId, B.brandId, `17${B.orgId.replace(/\D/g, '').slice(0, 15)}`],
  );
  const bTag = await api.pool.query(
    `INSERT INTO tag (organization_id, name, name_key) VALUES ($1, 'B tag', 'b tag') RETURNING id`,
    [B.orgId],
  );
  const bChannel = await new PgAlertChannels(api.pool, api.deps.env.encryption).createSlack(
    B.orgId,
    B.owner.userId,
    {
      label: 'b slack',
      webhookUrl: 'https://hooks.slack.com/services/T0EEEE5555/B0FFFF6666/qrstuvwxyzabcdefghijklmn',
    },
  );
  if (bChannel.status !== 'created') throw new Error('seed channel failed');
  await api.pool.query(
    `INSERT INTO alert_brand_settings (organization_id, brand_id) VALUES ($1, $2)`,
    [B.orgId, B.brandId],
  );
  await api.pool.query(
    `INSERT INTO alert_route (organization_id, brand_id, alert_type, channel_id, enabled, enabled_at)
     VALUES ($1, $2, 'negative_spike', $3, true, now())`,
    [B.orgId, B.brandId, bChannel.channel.id],
  );
  const bApiKey = await new PgApiKeys(api.pool).create(B.orgId, B.owner.userId, {
    name: 'b key',
    scope: 'write',
  });
  const grants = new PgOAuthGrantStore(api.pool, api.deps.env.encryption);
  const bGrantIds = { facebook: randomUUID(), instagram: randomUUID() };
  for (const platform of ['facebook', 'instagram'] as const) {
    await grants.save({
      id: bGrantIds[platform],
      organizationId: B.orgId,
      brandId: B.brandId,
      platform,
      initiatedByUserId: B.owner.userId,
      reconnectConnectionId: null,
      userToken: new Secret(`iso-user-token-${platform}`),
      grantedScopes: ['pages_show_list'],
      expiresAt: new Date(Date.now() + 600_000),
    });
  }
  const bGrantId = bGrantIds.facebook;
  const inv = await api.req('POST', `/api/v1/orgs/${B.orgId}/invitations`, {
    cookie: B.owner.cookie,
    body: { email: 'iso@x.test', role: 'member' },
  });
  await new Promise((r) => setTimeout(r, 20)); // emails are fire-and-forget
  const link = new URL(extractFirstUrl(api.mailer.lastTo('iso@x.test')!.text)!);
  f = {
    A,
    B,
    bInvitationId: inv.body.invitation.id,
    bInvitationToken: link.searchParams.get('token')!,
    bConnectionId,
    bCommentId: comment.rows[0].id,
    bAdId: bAd.rows[0].id,
    bGrantId,
    aRuleId: aRule.rows[0].id,
    bRuleId: bRule.rows[0].id,
    bDomainId: bDomain.rows[0].id,
    bClassifierRunId: bClassifierRun.rows[0].id,
    bStepId: bStep.rows[0].id,
    bHideActionId: bHide.rows[0].id,
    bReviewItemId: bReviewItem.rows[0].id,
    bSuggestionId: bSuggestion.rows[0].id,
    bPolicyId: bPolicy.rows[0].id,
    bPreviewId: bPreview.rows[0].id,
    bConnectionIds: { facebook: bConnectionId, instagram: igConnection.rows[0].id },
    bTagId: bTag.rows[0].id,
    bGrantIds,
    bAlertChannelId: bChannel.channel.id,
    bApiKeyId: bApiKey.key.id,
  };
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
      expect(beforeB.grants).toHaveLength(2);
      expect(beforeB.tags).toHaveLength(1);
      expect(beforeB.alertChannels).toHaveLength(1);
      expect(beforeB.alertRoutes).toHaveLength(1);
      const [method] = c.route.split(' ');
      const r = await api.req(method!, c.url(f), { cookie: f.A.owner.cookie, body: c.body?.(f) });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
      expect(await snapshot(f.B.orgId)).toEqual(beforeB);
      expect(await snapshot(f.A.orgId)).toEqual(beforeA);
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
