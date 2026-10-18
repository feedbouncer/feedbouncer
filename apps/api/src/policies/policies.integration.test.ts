// The policies API over a real app and database: CRUD with revisions, dry-run
// preview (the preview job runs with a scripted evaluator), explicit runs, limits,
// capabilities, and the decision log after a policy is archived.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgCommentStore } from '@feedbouncer/comments';
import { BrandSlots } from '@feedbouncer/db';
import type { JobContext } from '@feedbouncer/jobs';
import {
  PgPolicyEvaluationStore,
  PgPolicyPreviewStore,
  PgPolicyUsage,
  policyPreviewJob,
  type PolicyEvaluator,
  type PolicyMatch,
} from '@feedbouncer/policies';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const TEXT = 'Hide comments telling people to message another account';
const SECRET_PHRASE = 'message another account';

let api: TestApi;
let off: TestApi;
let evaluations: PgPolicyEvaluationStore;
let n = 0;
const orgs = {} as Record<
  'crud' | 'limits' | 'preview' | 'run' | 'quota' | 'log' | 'off',
  OrgFixture
>;

const base = (o: OrgFixture) => `/api/v1/orgs/${o.orgId}/brands/${o.brandId}`;
const get = (o: OrgFixture, path: string, cookie = o.member.cookie, app = api) =>
  app.req('GET', `${base(o)}${path}`, { cookie });
const send = (
  method: string,
  o: OrgFixture,
  path: string,
  body?: unknown,
  cookie = o.owner.cookie,
  app = api,
) => app.req(method, `${base(o)}${path}`, { cookie, ...(body !== undefined && { body }) });

beforeAll(async () => {
  api = await startTestApi({
    facebook: FACEBOOK,
    instagram: { meta: FACEBOOK },
    policy: { monthlyCallsPerBrand: 20_000, evaluatorConfigured: true },
  });
  off = await startTestApi({
    policy: { monthlyCallsPerBrand: 20_000, evaluatorConfigured: false },
  });
  evaluations = new PgPolicyEvaluationStore(api.pool);
  const first = await orgWithRoles(api, 'pol-crud');
  orgs.crud = first;
  const users = { owner: first.owner, admin: first.admin, member: first.member };
  for (const k of ['limits', 'preview', 'run', 'quota', 'log'] as const)
    orgs[k] = await orgWithRoles(api, `pol-${k}`, users);
  orgs.off = await orgWithRoles(off, 'pol-off');
});
afterAll(async () => {
  await off.close();
  await api.close();
});

async function create(o: OrgFixture, over: Record<string, unknown> = {}) {
  const r = await send('POST', o, '/policies', {
    name: `Policy ${++n}`,
    text: TEXT,
    action: 'hide',
    ...over,
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; revisionId: string; revision: number };
}

/** A live comment on a fresh connection that the rules left undecided. */
async function candidate(o: OrgFixture, scope?: { connectionId: string }) {
  const s =
    scope ??
    (await api.seedConnection(o, { platform: 'facebook', externalAccountId: `acct-${++n}` })).scope;
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [o.orgId, o.brandId, s.connectionId, `post-${++n}`],
  );
  const body = `dm me on my other account ${n}`;
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [o.orgId, o.brandId, s.connectionId, source.rows[0].id, `c-${n}`, body],
  );
  const sha = createHash('sha256').update(body).digest();
  const ev = await api.pool.query(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, ruleset_version, status) VALUES ($1, $2, $3, $4, $5, 'ingest', 'v1', 'no_match') RETURNING id`,
    [o.orgId, o.brandId, s.connectionId, comment.rows[0].id, sha],
  );
  return {
    commentId: comment.rows[0].id as string,
    connectionId: s.connectionId,
    sha,
    ruleEvaluationId: ev.rows[0].id as string,
  };
}

const counts = async (o: OrgFixture) =>
  (
    await api.pool.query(
      `SELECT (SELECT count(*) FROM decision WHERE organization_id = $1)::int AS decisions,
              (SELECT count(*) FROM policy_evaluation WHERE organization_id = $1)::int AS evaluations,
              (SELECT count(*) FROM moderation_action WHERE organization_id = $1)::int AS actions`,
      [o.orgId],
    )
  ).rows[0];

describe('policy CRUD', () => {
  const o = () => orgs.crud;

  it('create: validates text with clear messages; vague text saves with warnings; starts disabled', async () => {
    const empty = await send('POST', o(), '/policies', { name: 'x', text: '', action: 'hide' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('invalid_policy');
    expect(empty.body.error.issues[0]).toMatchObject({
      path: 'text',
      message: expect.stringContaining('Write the policy as a sentence'),
    });
    const short = await send('POST', o(), '/policies', { name: 'x', text: 'spam', action: 'hide' });
    expect(short.body.error.issues[0].message).toContain('at least 8 characters');
    const bidi = await send('POST', o(), '/policies', {
      name: 'x',
      text: 'Hide ‮comments asking for money',
      action: 'hide',
    });
    expect(bidi.status).toBe(400);
    const vague = await send('POST', o(), '/policies', {
      name: 'Vague',
      text: 'bad stuff',
      action: 'flag',
    });
    expect(vague.status).toBe(201);
    expect(vague.body).toMatchObject({
      enabled: false,
      revision: 1,
      action: 'flag',
      warnings: ['few_words', 'vague_terms'],
    });
    expect(Number.isNaN(Date.parse(vague.body.createdAt))).toBe(false);
  });

  it('a name can be used once among live policies', async () => {
    await create(o(), { name: 'Unique name' });
    const again = await send('POST', o(), '/policies', {
      name: 'Unique name',
      text: TEXT,
      action: 'flag',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('policy_name_taken');
  });

  it('edit text creates a new revision, history is kept, audit carries no text', async () => {
    const p = await create(o());
    const e = await send('PATCH', o(), `/policies/${p.id}`, {
      text: 'Hide comments asking readers to contact another profile',
    });
    expect(e.status).toBe(200);
    expect(e.body.revision).toBe(2);
    const renamed = await send('PATCH', o(), `/policies/${p.id}`, { name: 'Renamed' });
    expect(renamed.body).toMatchObject({ name: 'Renamed', revision: 2 });
    const d = await get(o(), `/policies/${p.id}`);
    expect(d.body.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
    expect(d.body.revisions[1]).toMatchObject({
      text: TEXT,
      action: 'hide',
      createdBy: { id: o().owner.userId },
    });
    const audit = await api.pool.query(
      `SELECT action, details FROM audit_event WHERE subject_id = $1 ORDER BY sequence`,
      [p.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'policy.created',
      'policy.revised',
      'policy.renamed',
    ]);
    expect(audit.rows[0].details).toEqual({ revision: 1, action: 'hide', vague: false });
    expect(JSON.stringify(audit.rows)).not.toContain(SECRET_PHRASE);
    expect(JSON.stringify(audit.rows)).not.toContain('another profile');
  });

  it('a patch that changes nothing adds no revision and audits nothing', async () => {
    const p = await create(o());
    const same = await send('PATCH', o(), `/policies/${p.id}`, { text: TEXT, action: 'hide' });
    expect(same.body.revision).toBe(1);
    const audit = await api.pool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE subject_id = $1`,
      [p.id],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('enable, disable and delete; enabling enqueues nothing', async () => {
    const p = await create(o());
    const spy = vi.spyOn(api.deps.producer!, 'enqueue');
    try {
      const jobsBefore = await api.pool.query(
        'SELECT count(*)::int AS n FROM job_ledger WHERE organization_id = $1',
        [o().orgId],
      );
      const on = await send('PATCH', o(), `/policies/${p.id}`, { enabled: true });
      expect(on.body.enabled).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const jobsAfter = await api.pool.query(
        'SELECT count(*)::int AS n FROM job_ledger WHERE organization_id = $1',
        [o().orgId],
      );
      expect(jobsAfter.rows[0].n).toBe(jobsBefore.rows[0].n);
      expect((await send('PATCH', o(), `/policies/${p.id}`, { enabled: false })).body.enabled).toBe(
        false,
      );
    } finally {
      spy.mockRestore();
    }
    expect((await send('DELETE', o(), `/policies/${p.id}`)).status).toBe(204);
    expect((await get(o(), `/policies/${p.id}`)).status).toBe(404);
    const audit = await api.pool.query(
      `SELECT action FROM audit_event WHERE subject_id = $1 ORDER BY sequence`,
      [p.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'policy.created',
      'policy.enabled',
      'policy.disabled',
      'policy.archived',
    ]);
  });

  it('list shows policies, limits, usage and whether policy checks are available', async () => {
    const r = await get(o(), '/policies');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      limits: { maxPolicies: 20, maxEnabled: 10 },
      usage: { used: 0, limit: 20_000 },
      evaluatorConfigured: true,
    });
    expect(Number.isNaN(Date.parse(r.body.usage.resetsAt))).toBe(false);
    expect(r.body.policies.length).toBeGreaterThan(0);
    const offList = await get(orgs.off, '/policies', orgs.off.member.cookie, off);
    expect(offList.body.evaluatorConfigured).toBe(false);
  });

  it('members read but do not write; admins write', async () => {
    const o2 = o();
    expect((await get(o2, '/policies')).status).toBe(200);
    const body = { name: 'By member', text: TEXT, action: 'flag' };
    expect((await send('POST', o2, '/policies', body, o2.member.cookie)).status).toBe(403);
    expect((await send('POST', o2, '/policies', body, o2.admin.cookie)).status).toBe(201);
    const p = await create(o2);
    for (const [method, path, payload] of [
      ['PATCH', `/policies/${p.id}`, { enabled: true }],
      ['DELETE', `/policies/${p.id}`, undefined],
      ['POST', `/policies/${p.id}/runs`, { days: 1 }],
      ['POST', '/policy-previews', { text: TEXT, action: 'flag' }],
    ] as const)
      expect((await send(method, o2, path, payload, o2.member.cookie)).status).toBe(403);
  });
});

describe('limits', () => {
  it('20 policies per brand and 10 enabled', async () => {
    const o = orgs.limits;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await create(o)).id);
    const over = await send('POST', o, '/policies', {
      name: 'One more',
      text: TEXT,
      action: 'flag',
    });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({
      code: 'policy_limit_reached',
      max: 20,
      message: 'A brand can have at most 20 policies.',
    });
    for (const id of ids.slice(0, 10))
      expect((await send('PATCH', o, `/policies/${id}`, { enabled: true })).status).toBe(200);
    const eleventh = await send('PATCH', o, `/policies/${ids[10]}`, { enabled: true });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error).toMatchObject({
      code: 'policy_limit_reached',
      max: 10,
      message: 'At most 10 policies can be enabled at once.',
    });
    // Deleting one frees a slot.
    expect((await send('DELETE', o, `/policies/${ids[0]}`)).status).toBe(204);
    expect((await send('PATCH', o, `/policies/${ids[10]}`, { enabled: true })).status).toBe(200);
  });
});

describe('preview', () => {
  const o = () => orgs.preview;

  it('202, one running preview per brand, results after the job ran, nothing acted on', async () => {
    const first = await candidate(o());
    const second = await candidate(o(), first);
    const connectionId = first.connectionId;
    const before = await counts(o());

    const started = await send('POST', o(), '/policy-previews', {
      text: TEXT,
      action: 'hide',
      days: 7,
    });
    expect(started.status).toBe(202);
    const previewId = started.body.id as string;
    const again = await send('POST', o(), '/policy-previews', { text: TEXT, action: 'hide' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('policy_preview_in_progress');

    const running = await get(o(), `/policy-previews/${previewId}`);
    expect(running.body).toMatchObject({ id: previewId, status: 'running', total: 2, examined: 0 });

    const evaluator: PolicyEvaluator = {
      enabled: true,
      id: 'fake',
      model: 'fake-1',
      evaluate: async () => ({
        verdicts: { p1: 'clear_match' },
        usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null },
      }),
    };
    const job = policyPreviewJob({
      comments: new PgCommentStore(api.pool),
      previews: new PgPolicyPreviewStore(api.pool),
      evaluator,
      slots: new BrandSlots(api.pool, 2, 'fb.policy'),
      usage: new PgPolicyUsage(api.pool),
      monthlyCallsPerBrand: 20_000,
      next: async () => {},
    });
    const ctx: JobContext = {
      scope: { organizationId: o().orgId, brandId: o().brandId, connectionId },
      platform: 'facebook',
      jobType: 'policy_preview',
      ledgerId: randomUUID(),
      attempt: 1,
      isReplay: false,
      signal: new AbortController().signal,
      log: createLogger('policy-preview-api-test', 'error', () => {}),
    };
    await job.handle(ctx, { previewId, chunk: 0 });

    const done = await get(o(), `/policy-previews/${previewId}`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      id: previewId,
      status: 'done',
      action: 'hide',
      days: 7,
      total: 2,
      capped: false,
      examined: 2,
      matched: 2,
      errors: 0,
      notChecked: 0,
      stoppedReason: null,
    });
    expect(Number.isNaN(Date.parse(done.body.completedAt))).toBe(false);
    expect(done.body.results).toHaveLength(2);
    expect(done.body.results[0]).toMatchObject({
      verdict: 'clear_match',
      proposedAction: 'hide',
      reason: 'Clear match: would hide.',
      platform: 'facebook',
    });
    expect([first.commentId, second.commentId]).toContain(done.body.results[0].commentId);
    expect(await counts(o())).toEqual(before);
    // The preview consumed model calls from the brand's monthly budget.
    expect((await get(o(), '/policies')).body.usage.used).toBe(2);
    // The finished preview no longer blocks a new one.
    const next = await send('POST', o(), '/policy-previews', { text: TEXT, action: 'flag' });
    expect(next.status).toBe(202);
  });

  it('a preview with nothing to check is done at once with no results', async () => {
    const empty = orgs.crud;
    const r = await send('POST', empty, '/policy-previews', {
      text: TEXT,
      action: 'flag',
      days: 1,
    });
    expect(r.status).toBe(202);
    const v = await get(empty, `/policy-previews/${r.body.id}`);
    expect(v.body).toMatchObject({ status: 'done', total: 0, examined: 0, results: [] });
  });

  it('validates the draft like a policy, and a previewed policy must exist', async () => {
    const bad = await send('POST', o(), '/policy-previews', { text: 'spam', action: 'hide' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_policy');
    const missing = await send('POST', o(), '/policy-previews', {
      text: TEXT,
      action: 'hide',
      policyId: randomUUID(),
    });
    expect(missing.status).toBe(404);
  });

  it('503 when policy checks are off in this deployment', async () => {
    const r = await send(
      'POST',
      orgs.off,
      '/policy-previews',
      { text: TEXT, action: 'flag' },
      undefined,
      off,
    );
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('policy_evaluation_unavailable');
  });

  it('429 when the monthly budget is used, naming the reset date', async () => {
    const o2 = orgs.quota;
    const p = await create(o2, { name: 'Quota policy' });
    await send('PATCH', o2, `/policies/${p.id}`, { enabled: true });
    await api.pool.query(
      `INSERT INTO policy_usage (organization_id, brand_id, period_start, model_calls)
       VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 20000)`,
      [o2.orgId, o2.brandId],
    );
    const preview = await send('POST', o2, '/policy-previews', { text: TEXT, action: 'flag' });
    expect(preview.status).toBe(429);
    expect(preview.body.error.code).toBe('policy_quota_exhausted');
    expect(preview.body.error.message).toMatch(
      /^This brand has used its 20,000 policy checks for this month\. Checks resume on 1 [A-Z][a-z]+\.$/,
    );
    const run = await send('POST', o2, `/policies/${p.id}/runs`, { days: 1 });
    expect(run.status).toBe(429);
    expect((await get(o2, '/policies')).body.usage).toMatchObject({ used: 20_000, limit: 20_000 });
  });
});

describe('apply to recent comments', () => {
  const o = () => orgs.run;

  it('needs an enabled policy, enqueues one job per active connection, audits, and waits 15 minutes', async () => {
    const connections = [
      (await api.seedConnection(o(), { platform: 'facebook', externalAccountId: 'run-fb-1' }))
        .scope,
      (await api.seedConnection(o(), { platform: 'instagram', externalAccountId: 'run-ig-1' }))
        .scope,
    ];
    const revoked = await api.seedConnection(o(), {
      platform: 'facebook',
      externalAccountId: 'run-x',
    });
    await api.pool.query("UPDATE connection SET status = 'revoked' WHERE id = $1", [
      revoked.scope.connectionId,
    ]);
    const p = await create(o());
    const spy = vi.spyOn(api.deps.producer!, 'enqueue');
    try {
      const notEnabled = await send('POST', o(), `/policies/${p.id}/runs`, { days: 3 });
      expect(notEnabled.status).toBe(409);
      expect(notEnabled.body.error.code).toBe('policy_not_enabled');
      await send('PATCH', o(), `/policies/${p.id}`, { enabled: true });
      expect(spy).not.toHaveBeenCalled();

      const r = await send('POST', o(), `/policies/${p.id}/runs`, { days: 3 });
      expect(r.status).toBe(202);
      expect(r.body.connections).toBe(2);
      const runId = r.body.id as string;
      const jobs = spy.mock.calls.map(([q]) => q).filter((q) => q.type === 'policy_run');
      expect(jobs.map((q) => q.scope.connectionId).sort()).toEqual(
        connections.map((s) => s.connectionId).sort(),
      );
      for (const q of jobs) expect(q.payload).toEqual({ runId });
      const run = await api.pool.query(
        'SELECT days, policy_id, revision_id, requested_by_user_id FROM policy_run WHERE id = $1 AND brand_id = $2',
        [runId, o().brandId],
      );
      expect(run.rows).toEqual([
        {
          days: 3,
          policy_id: p.id,
          revision_id: p.revisionId,
          requested_by_user_id: o().owner.userId,
        },
      ]);
      const audit = await api.pool.query(
        `SELECT subject_type, subject_id, details FROM audit_event
          WHERE brand_id = $1 AND action = 'policy.run_requested'`,
        [o().brandId],
      );
      expect(audit.rows).toEqual([
        { subject_type: 'policy_run', subject_id: runId, details: { days: 3, revision: 1 } },
      ]);

      const soon = await send('POST', o(), `/policies/${p.id}/runs`, { days: 3 });
      expect(soon.status).toBe(409);
      expect(soon.body.error.code).toBe('policy_run_too_soon');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects more than 7 days', async () => {
    const p = await create(orgs.crud);
    const r = await send('POST', orgs.crud, `/policies/${p.id}/runs`, { days: 30 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_policy');
  });
});

describe('decision log and evaluation', () => {
  const o = () => orgs.log;

  const match = (
    p: { id: string; revisionId: string },
    name: string,
    over: Partial<PolicyMatch> = {},
  ): PolicyMatch => ({
    policyId: p.id,
    revisionId: p.revisionId,
    revision: 1,
    name,
    confidence: 'high',
    action: 'hide',
    effectiveAction: 'hide',
    downgrade: null,
    ...over,
  });

  it('a policy decision shows its policy, revision, text and every match, and survives archive and edits', async () => {
    const p1 = await create(o(), { name: 'No DMs' });
    const p2 = await create(o(), {
      name: 'No spam links',
      text: 'Flag comments that advertise products',
    });
    const c = await candidate(o());
    const winner = match(p1, 'No DMs');
    const low = match(p2, 'No spam links', {
      confidence: 'low',
      effectiveAction: 'flag',
      downgrade: 'low_confidence',
    });
    const scope = { organizationId: o().orgId, brandId: o().brandId, connectionId: c.connectionId };
    const row = await evaluations.record(scope, {
      status: 'evaluated',
      commentId: c.commentId,
      sha: c.sha,
      triggerKey: 'ingest',
      ruleEvaluationId: c.ruleEvaluationId,
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'pol-v1',
      checkedRevisionIds: [p1.revisionId, p2.revisionId],
      usage: null,
      inputTruncated: false,
      lowSignal: false,
      decision: { outcome: 'hide', winner, matches: [winner, low] },
      reason: 'Matched 2 policies',
    });
    expect(row).not.toBeNull();

    await send('PATCH', o(), `/policies/${p1.id}`, {
      text: 'Hide comments that ask readers to move the chat elsewhere',
    });
    expect((await send('DELETE', o(), `/policies/${p1.id}`)).status).toBe(204);

    const r = await get(o(), `/comments/${c.commentId}/decisions`);
    expect(r.status).toBe(200);
    expect(r.body.decisions).toHaveLength(1);
    expect(r.body.decisions[0]).toMatchObject({
      actorType: 'policy',
      outcome: 'hide',
      rule: null,
      classifier: null,
      policy: {
        evaluationId: row!.id,
        policyId: p1.id,
        name: 'No DMs',
        archived: true,
        revision: 1,
        text: TEXT,
        matches: [
          {
            policyId: p1.id,
            name: 'No DMs',
            archived: true,
            revision: 1,
            confidence: 'high',
            action: 'hide',
            effectiveAction: 'hide',
            downgrade: null,
          },
          {
            policyId: p2.id,
            name: 'No spam links',
            archived: false,
            revision: 1,
            confidence: 'low',
            action: 'hide',
            effectiveAction: 'flag',
            downgrade: 'low_confidence',
          },
        ],
      },
    });

    const only = await get(o(), `/rule-activity?source=policy&policyId=${p1.id}`);
    expect(only.status).toBe(200);
    expect(only.body.items.map((i: { commentId: string }) => i.commentId)).toEqual([c.commentId]);
    expect(only.body.items[0].policy.name).toBe('No DMs');
    const other = await get(o(), `/rule-activity?source=policy&policyId=${p2.id}`);
    expect(other.body.items).toEqual([]);
    const all = await get(o(), '/rule-activity');
    expect(all.body.items.map((i: { actorType: string }) => i.actorType)).toContain('policy');
    expect((await get(o(), '/rule-activity?policyId=not-a-uuid')).status).toBe(400);

    const ev = await get(o(), `/comments/${c.commentId}/policy-evaluation`);
    expect(ev.status).toBe(200);
    expect(ev.body.evaluation).toMatchObject({
      id: row!.id,
      status: 'evaluated',
      outcome: 'hide',
      checkedCount: 2,
      triggerKey: 'ingest',
      matches: [{ name: 'No DMs', text: TEXT }, { name: 'No spam links' }],
    });
  });

  it('shows failed checks, and null when a comment was never checked', async () => {
    const p = await create(o());
    const failed = await candidate(o());
    await evaluations.record(
      { organizationId: o().orgId, brandId: o().brandId, connectionId: failed.connectionId },
      {
        status: 'failed',
        provider: 'openai',
        model: 'gpt-test',
        commentId: failed.commentId,
        sha: failed.sha,
        triggerKey: 'ingest',
        ruleEvaluationId: failed.ruleEvaluationId,
        failureCode: 'unavailable',
        checkedRevisionIds: [p.revisionId],
        usage: null,
      },
    );
    const r = await get(o(), `/comments/${failed.commentId}/policy-evaluation`);
    expect(r.status).toBe(200);
    expect(r.body.evaluation).toMatchObject({
      status: 'failed',
      provider: 'openai',
      model: 'gpt-test',
      failureCode: 'unavailable',
      matches: [],
    });

    const unchecked = await candidate(o());
    const none = await get(o(), `/comments/${unchecked.commentId}/policy-evaluation`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ evaluation: null });
  });

  it('no policy text reaches the audit trail or the log lines', async () => {
    const audit = await api.pool.query(
      `SELECT details FROM audit_event WHERE organization_id = ANY($1::uuid[])`,
      [Object.values(orgs).map((x) => x.orgId)],
    );
    expect(JSON.stringify(audit.rows)).not.toContain(SECRET_PHRASE);
    expect(api.logLines.join('\n')).not.toContain(SECRET_PHRASE);
  });
});
