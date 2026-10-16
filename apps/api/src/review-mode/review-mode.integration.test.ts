// Review mode over the API: opt-out at connect, the status, the suggestion queue,
// decisions, bulk and the early exit. FakeGraph stands in for Meta during connect.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgSuggestionStore } from '@feedbouncer/actions';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { Secret } from '@feedbouncer/service-runtime';
import {
  WEB,
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';

const SECRET = 'fb-app-secret-0123456789abcdef';
const APP_ID = '1112223334';
const FACEBOOK = {
  appId: APP_ID,
  appSecret: new Secret(SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const HOUR = 3_600_000;

let api: TestApi;
let graph: FakeGraph;
let org: OrgFixture;
let other: OrgFixture;
let fbUserId: string;
let seq = 0;

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi(
    { facebook: FACEBOOK, instagram: { meta: FACEBOOK } },
    { fetch: graph.fetch },
  );
  org = await orgWithRoles(api, 'rvm');
  other = await orgWithRoles(api, 'rvo', {
    owner: org.admin,
    admin: org.owner,
    member: org.member,
  });
  fbUserId = graph.addUser('Dana').userId;
  await api.pool.query("UPDATE app_user SET display_name = 'Olive' WHERE id = $1", [
    org.owner.userId,
  ]);
});
afterAll(() => api.close());

const base = (f: OrgFixture) => `/api/v1/orgs/${f.orgId}/brands/${f.brandId}`;
const call = (method: string, url: string, user: TestUser, body?: unknown) =>
  api.req(method, url, { cookie: user.cookie, ...(body !== undefined && { body }) });

async function grantFor(f: OrgFixture): Promise<string> {
  const r = await call('POST', `${base(f)}/connections/facebook/authorize`, f.owner, {});
  expect(r.status).toBe(200);
  const url = new URL(r.body.authorizationUrl);
  const c = graph.consent(url, fbUserId);
  const cb = await call(
    'GET',
    `/api/v1/oauth/facebook/callback?code=${encodeURIComponent(c.code)}&state=${c.state}`,
    f.owner,
  );
  const m = /\?grant=([0-9a-f-]{36})$/.exec(String(cb.headers.location));
  expect(String(cb.headers.location).startsWith(WEB)).toBe(true);
  return m![1]!;
}

const connectPage = async (body: Record<string, unknown> = {}) => {
  const { pageId } = graph.addPage(fbUserId, { name: `Page ${++seq}` });
  const grantId = await grantFor(org);
  return call('POST', `${base(org)}/connections/facebook/grants/${grantId}/connect`, org.owner, {
    accountIds: [pageId],
    ...body,
  });
};

/** An active Facebook connection whose review window started an hour ago. */
async function reviewConnection(f: OrgFixture): Promise<string> {
  const { scope } = await api.seedFacebookConnection(f);
  await api.pool.query(
    `UPDATE connection SET review_mode = 'on', review_mode_started_at = now() - interval '1 hour',
            review_mode_ends_at = now() - interval '1 hour' + interval '168 hours'
      WHERE id = $1`,
    [scope.connectionId],
  );
  return scope.connectionId;
}

/** A comment with a pending hide (or delete) suggestion from the classifier. */
async function suggest(
  f: OrgFixture,
  connectionId: string,
  o: { authorId?: string; type?: 'hide' | 'delete' } = {},
): Promise<{ suggestionId: string; commentId: string }> {
  const n = ++seq;
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [f.orgId, f.brandId, connectionId, `7_${n}`],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                          author_id, posted_at)
     VALUES ($1, $2, $3, $4, $5, 'secret body', $6, now()) RETURNING id`,
    [f.orgId, f.brandId, connectionId, source.rows[0].id, `7_${n}_1`, o.authorId ?? null],
  );
  const commentId: string = comment.rows[0].id;
  const type = o.type ?? 'hide';
  const r = await new PgSuggestionStore(api.pool).propose(
    { organizationId: f.orgId, brandId: f.brandId, connectionId },
    {
      commentId,
      source: { type: 'classifier', ref: randomUUID() },
      steps: [type === 'hide' ? { type } : { type, confirmIrreversible: true }],
      reason: 'spam',
    },
  );
  if (!('suggestionId' in r)) throw new Error('not proposed');
  return { suggestionId: r.suggestionId, commentId };
}

async function author(f: OrgFixture, connectionId: string, name: string): Promise<string> {
  const r = await api.pool.query(
    `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [f.orgId, f.brandId, connectionId, `a${++seq}`, name],
  );
  return r.rows[0].id;
}

const decide = (
  id: string,
  action: 'approve' | 'dismiss',
  user: TestUser = org.owner,
  body: Record<string, unknown> = {},
) =>
  call('POST', `${base(org)}/suggestions/${id}/${action}`, user, {
    requestKey: `k-${randomUUID()}`,
    ...body,
  });

describe('opt-out at connect', () => {
  it('connect without reviewMode -> connection active in review mode with endsAt 168h later', async () => {
    const before = Date.now();
    const r = await connectPage();
    expect(r.status).toBe(200);
    const [res] = r.body.results;
    expect(res.status).toBe('connected');
    expect(res.reviewMode.state).toBe('active');
    const endsAt = Date.parse(res.reviewMode.endsAt);
    expect(endsAt).toBeGreaterThanOrEqual(before + 168 * HOUR - 1000);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 168 * HOUR + 1000);
    const row = await api.pool.query(
      `SELECT review_mode, extract(epoch FROM review_mode_ends_at - review_mode_started_at)::int AS span
         FROM connection WHERE id = $1`,
      [res.connectionId],
    );
    expect(row.rows[0].review_mode).toBe('on');
    expect(row.rows[0].span).toBe(168 * 3600);
  });

  it('connect with reviewMode off and acknowledgeRisk -> opted_out, audit review_mode.opted_out', async () => {
    const r = await connectPage({ reviewMode: 'off', acknowledgeRisk: true });
    expect(r.status).toBe(200);
    const [res] = r.body.results;
    expect(res.reviewMode).toEqual({ state: 'opted_out', endsAt: null });
    const audit = await api.pool.query(
      `SELECT actor_user_id FROM audit_event
        WHERE subject_id = $1 AND action = 'review_mode.opted_out'`,
      [res.connectionId],
    );
    expect(audit.rows).toEqual([{ actor_user_id: org.owner.userId }]);
  });

  it('connect with reviewMode off without acknowledgeRisk -> 422 risk_not_acknowledged', async () => {
    const r = await connectPage({ reviewMode: 'off' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('risk_not_acknowledged');
    const bad = await connectPage({ reviewMode: 'on', acknowledgeRisk: false });
    expect(bad.status).toBe(400);
  });
});

describe('status and early exit', () => {
  it('member cannot end review mode (403); admin can', async () => {
    const connectionId = await reviewConnection(org);
    const url = `${base(org)}/connections/${connectionId}/review-mode/end`;
    const denied = await call('POST', url, org.member, { pending: 'leave' });
    expect(denied.status).toBe(403);
    const r = await call('POST', url, org.admin, { pending: 'leave' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ended', pendingCount: 0 });
    const again = await call('POST', url, org.admin, { pending: 'leave' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('review_mode_not_active');
  });

  it('approve-all without confirm -> 422 confirmation_required; unknown connection -> 404', async () => {
    const connectionId = await reviewConnection(org);
    const r = await call(
      'POST',
      `${base(org)}/connections/${connectionId}/review-mode/end`,
      org.owner,
      { pending: 'approve' },
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('confirmation_required');
    const foreign = await reviewConnection(other);
    const cross = await call(
      'POST',
      `${base(org)}/connections/${foreign}/review-mode/end`,
      org.owner,
      { pending: 'leave' },
    );
    expect(cross.status).toBe(404);
  });

  it('GET review-mode shows state, endsAt and pendingCount', async () => {
    const connectionId = await reviewConnection(org);
    await suggest(org, connectionId);
    await suggest(org, connectionId);
    const r = await call('GET', `${base(org)}/review-mode`, org.member);
    expect(r.status).toBe(200);
    const row = await api.pool.query(
      'SELECT review_mode_started_at, review_mode_ends_at FROM connection WHERE id = $1',
      [connectionId],
    );
    const s = r.body.connections.find(
      (c: { connectionId: string }) => c.connectionId === connectionId,
    );
    expect(s).toEqual({
      connectionId,
      platform: 'facebook',
      displayName: null,
      state: 'active',
      startedAt: row.rows[0].review_mode_started_at.toISOString(),
      endsAt: row.rows[0].review_mode_ends_at.toISOString(),
      endedAt: null,
      graceEndsAt: new Date(row.rows[0].review_mode_ends_at.getTime() + 72 * HOUR).toISOString(),
      pendingCount: 2,
    });
    expect(r.body.pendingTotal).toBeGreaterThanOrEqual(2);
  });

  it('connections list includes reviewMode', async () => {
    const connectionId = await reviewConnection(org);
    const r = await call('GET', `${base(org)}/connections`, org.owner);
    expect(r.status).toBe(200);
    const c = r.body.connections.find((x: { id: string }) => x.id === connectionId);
    expect(c.reviewMode).toMatchObject({ connectionId, state: 'active', pendingCount: 0 });
  });
});

describe('suggestion queue and decisions', () => {
  it('lists pending suggestions with the comment, sources and plan; filters by connection', async () => {
    const connectionId = await reviewConnection(org);
    const authorId = await author(org, connectionId, 'Sam');
    const { suggestionId } = await suggest(org, connectionId, { authorId });
    await suggest(org, connectionId, { authorId });
    const r = await call(
      'GET',
      `${base(org)}/suggestions?connectionId=${connectionId}`,
      org.member,
    );
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.next).toBeNull();
    const item = r.body.items.find((i: { id: string }) => i.id === suggestionId);
    expect(item).toMatchObject({
      id: suggestionId,
      connectionId,
      platform: 'facebook',
      commentBody: 'secret body',
      authorId,
      authorName: 'Sam',
      authorPendingCount: 2,
      status: 'pending',
      sources: [{ type: 'classifier', reason: 'spam', steps: [{ type: 'hide' }] }],
      plan: { steps: [{ type: 'hide' }], dropped: [] },
      execution: null,
    });
    expect(typeof item.createdAt).toBe('string');
    const page = await call(
      'GET',
      `${base(org)}/suggestions?connectionId=${connectionId}&limit=1`,
      org.owner,
    );
    expect(page.body.items).toHaveLength(1);
    expect(page.body.next).toBe(page.body.items[0].id);

    const authors = await call(
      'GET',
      `${base(org)}/suggestions/authors?connectionId=${connectionId}`,
      org.member,
    );
    expect(authors.status).toBe(200);
    expect(authors.body).toEqual({ items: [{ authorId, authorName: 'Sam', pendingCount: 2 }] });
    const missing = await call('GET', `${base(org)}/suggestions/authors`, org.member);
    expect(missing.status).toBe(400);
    const foreign = await reviewConnection(other);
    const cross = await call('GET', `${base(org)}/suggestions?connectionId=${foreign}`, org.owner);
    expect(cross.status).toBe(404);
  });

  it('approve -> 200 approved; second moderator -> 409 suggestion_already_handled with decidedByName', async () => {
    const connectionId = await reviewConnection(org);
    const { suggestionId } = await suggest(org, connectionId);
    const requestKey = `k-${randomUUID()}`;
    const r = await decide(suggestionId, 'approve', org.owner, { requestKey });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'approved', steps: ['hide'], dropped: [] });
    const replay = await decide(suggestionId, 'approve', org.owner, { requestKey });
    expect(replay.status).toBe(200);
    expect(replay.body.runId).toBe(r.body.runId);

    const second = await decide(suggestionId, 'approve', org.member);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({
      code: 'suggestion_already_handled',
      handled: { status: 'approved', decidedByName: 'Olive' },
    });
    expect(Date.parse(second.body.error.handled.decidedAt)).not.toBeNaN();
    const audit = await api.pool.query(
      `SELECT actor_user_id FROM audit_event WHERE subject_id = $1 AND action = 'suggestion.approved'`,
      [suggestionId],
    );
    expect(audit.rows).toEqual([{ actor_user_id: org.owner.userId }]);
  });

  it('dismiss -> 200 dismissed', async () => {
    const connectionId = await reviewConnection(org);
    const { suggestionId } = await suggest(org, connectionId);
    const r = await decide(suggestionId, 'dismiss', org.member);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'dismissed' });
  });

  it('approve with delete in the plan needs confirm -> 422 confirmation_required', async () => {
    const connectionId = await reviewConnection(org);
    const { suggestionId } = await suggest(org, connectionId, { type: 'delete' });
    const r = await decide(suggestionId, 'approve');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('confirmation_required');
    const ok = await decide(suggestionId, 'approve', org.owner, { confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
  });

  it('approve deleted comment -> 200 not_applicable', async () => {
    const connectionId = await reviewConnection(org);
    const { suggestionId, commentId } = await suggest(org, connectionId);
    await api.pool.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [
      commentId,
    ]);
    const r = await decide(suggestionId, 'approve');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'not_applicable', reason: 'comment_gone' });
  });

  it('approve with reconnect needed -> 409 connection_needs_reconnect', async () => {
    const connectionId = await reviewConnection(org);
    const { suggestionId } = await suggest(org, connectionId);
    await api.pool.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'token_expired' WHERE id = $1",
      [connectionId],
    );
    const r = await decide(suggestionId, 'approve');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('connection_needs_reconnect');
    const row = await api.pool.query('SELECT status FROM action_suggestion WHERE id = $1', [
      suggestionId,
    ]);
    expect(row.rows[0].status).toBe('pending');
  });

  it('unknown or malformed suggestion ids -> 404; client keys cannot use the suggestion: prefix', async () => {
    expect((await decide(randomUUID(), 'approve')).status).toBe(404);
    expect((await decide('nope', 'dismiss')).status).toBe(404);
    const connectionId = await reviewConnection(org);
    const { suggestionId } = await suggest(org, connectionId);
    const forged = await decide(suggestionId, 'approve', org.owner, {
      requestKey: `suggestion:${suggestionId}:hide`,
    });
    expect(forged.status).toBe(400);
  });
});

describe('bulk', () => {
  it('bulk with ids returns per-item results', async () => {
    const connectionId = await reviewConnection(org);
    const a = await suggest(org, connectionId);
    const b = await suggest(org, connectionId);
    const r = await call('POST', `${base(org)}/suggestions/bulk`, org.member, {
      action: 'dismiss',
      ids: [a.suggestionId, b.suggestionId],
      requestKey: `k-${randomUUID()}`,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      results: [
        { id: a.suggestionId, result: { status: 'dismissed' } },
        { id: b.suggestionId, result: { status: 'dismissed' } },
      ],
    });
  });

  it('bulk with 101 ids -> 400', async () => {
    const r = await call('POST', `${base(org)}/suggestions/bulk`, org.owner, {
      action: 'approve',
      ids: Array.from({ length: 101 }, () => randomUUID()),
      requestKey: `k-${randomUUID()}`,
    });
    expect(r.status).toBe(400);
  });

  it('bulk filter -> 202 matched and an audit row', async () => {
    const connectionId = await reviewConnection(org);
    const authorId = await author(org, connectionId, 'Lee');
    await suggest(org, connectionId, { authorId });
    await suggest(org, connectionId, { authorId });
    await suggest(org, connectionId);
    const r = await call('POST', `${base(org)}/suggestions/bulk`, org.owner, {
      action: 'dismiss',
      connectionId,
      filter: { authorId },
      requestKey: `k-${randomUUID()}`,
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ matched: 2 });
    const audit = await api.pool.query(
      `SELECT details FROM audit_event WHERE subject_id = $1 AND action = 'suggestion.bulk_requested'`,
      [connectionId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('bulk filter cannot claim the early-exit request key', async () => {
    const connectionId = await reviewConnection(org);
    await suggest(org, connectionId);
    const r = await call('POST', `${base(org)}/suggestions/bulk`, org.owner, {
      action: 'dismiss',
      connectionId,
      filter: {},
      requestKey: `review_end:${connectionId}`,
    });
    expect(r.status).toBe(400);
  });

  it("bulk filter with another brand's connectionId -> 404", async () => {
    const foreign = await reviewConnection(other);
    await suggest(other, foreign);
    const r = await call('POST', `${base(org)}/suggestions/bulk`, org.owner, {
      action: 'dismiss',
      connectionId: foreign,
      filter: {},
      requestKey: `k-${randomUUID()}`,
    });
    expect(r.status).toBe(404);
    const audit = await api.pool.query(
      `SELECT 1 FROM audit_event WHERE subject_id = $1 AND action = 'suggestion.bulk_requested'`,
      [foreign],
    );
    expect(audit.rows).toHaveLength(0);
  });
});
