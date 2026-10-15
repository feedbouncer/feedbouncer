// The classifier's API over a real app and database: settings, preview, re-runs,
// the per-comment classification and the decision log. Classifications are
// recorded through the real store; the worker's jobs are not run.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  PgClassificationStore,
  ZERO_SCORES,
  decide,
  prepareInput,
  type Category,
} from '@feedbouncer/classifier';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

let api: TestApi;
let store: PgClassificationStore;
let A: OrgFixture; // settings and audit
let P: OrgFixture; // preview, classification and decision log
let R: OrgFixture; // re-runs
let n = 0;

const base = (o: OrgFixture) => `/api/v1/orgs/${o.orgId}/brands/${o.brandId}`;
const member = (o: OrgFixture) => o.member.cookie;
const admin = (o: OrgFixture) => o.admin.cookie;
const get = (o: OrgFixture, path: string, cookie = member(o)) =>
  api.req('GET', `${base(o)}${path}`, { cookie });
const send = (method: string, o: OrgFixture, path: string, cookie: string, body?: unknown) =>
  api.req(method, `${base(o)}${path}`, { cookie, ...(body !== undefined && { body }) });

beforeAll(async () => {
  api = await startTestApi({
    facebook: FACEBOOK,
    instagram: { meta: FACEBOOK },
    classifier: { id: 'fake', model: 'fake-1', enabled: true },
  });
  store = new PgClassificationStore(api.pool);
  A = await orgWithRoles(api, 'clfa');
  const users = { owner: A.owner, admin: A.admin, member: A.member };
  P = await orgWithRoles(api, 'clfp', users);
  R = await orgWithRoles(api, 'clfr', users);
});
afterAll(() => api.close());

const sha = (s: string) => createHash('sha256').update(s).digest();

/** A live comment on a fresh active connection of the org, optionally classified with the given scores. */
async function seedClassified(
  o: OrgFixture,
  scores: Partial<Record<Category, number>> | null,
  opts: { triggerKey?: string; status?: 'unclassified' } = {},
) {
  const { scope } = await api.seedConnection(o, {
    platform: 'facebook',
    externalAccountId: `acct-${++n}-${randomUUID().slice(0, 8)}`,
  });
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [scope.organizationId, scope.brandId, scope.connectionId, `post-${n}`],
  );
  const body = `comment body ${n}`;
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [scope.organizationId, scope.brandId, scope.connectionId, source.rows[0].id, `c-${n}`, body],
  );
  const commentId = comment.rows[0].id as string;
  if (scores === null) return { commentId, scope };
  const hash = sha(body);
  const triggerKey = opts.triggerKey ?? 'ingest';
  const input = prepareInput(body);
  if (opts.status === 'unclassified') {
    await store.record(scope, {
      commentId,
      sha: hash,
      triggerKey,
      status: 'unclassified',
      unclassifiedReason: 'timeout',
      input,
    });
    return { commentId, scope };
  }
  const full = { ...ZERO_SCORES, ...scores };
  const ev = await api.pool.query(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, ruleset_version, status) VALUES ($1, $2, $3, $4, $5, $6, 'v1', 'no_match') RETURNING id`,
    [scope.organizationId, scope.brandId, scope.connectionId, commentId, hash, triggerKey],
  );
  await store.record(scope, {
    commentId,
    sha: hash,
    triggerKey,
    status: 'classified',
    provider: 'fake',
    model: 'fake-1',
    promptVersion: 'v1',
    scores: full,
    language: 'en',
    languageSupported: true,
    input,
    scoresReused: false,
    ruleEvaluationId: ev.rows[0].id,
    ruleDecided: false,
    policy: DEFAULT_THRESHOLDS,
    verdict: decide(full, DEFAULT_THRESHOLDS, {
      lowSignal: input.lowSignal,
      languageSupported: true,
    }),
    reason: 'Classifier: matched policy',
  });
  return { commentId, scope };
}

const counts = async (o: OrgFixture) =>
  (
    await api.pool.query(
      `SELECT (SELECT count(*) FROM decision WHERE organization_id = $1)::int AS decisions,
              (SELECT count(*) FROM comment_classification WHERE organization_id = $1)::int AS classifications,
              (SELECT count(*) FROM moderation_action WHERE organization_id = $1)::int AS actions`,
      [o.orgId],
    )
  ).rows[0];

describe('classifier settings', () => {
  it('GET: a new brand sees documented defaults and the configured provider', async () => {
    const r = await get(A, '/classifier/settings');
    expect(r.status).toBe(200);
    expect(r.body.provider).toEqual({ id: 'fake', model: 'fake-1', enabled: true });
    expect(r.body.categories).toHaveLength(7);
    expect(
      r.body.categories.find((c: { category: string }) => c.category === 'hate_speech'),
    ).toEqual({
      category: 'hate_speech',
      threshold: 0.8,
      action: 'hide',
      source: 'default',
      updatedAt: null,
      updatedBy: null,
    });
    expect(
      r.body.categories.find((c: { category: string }) => c.category === 'spam'),
    ).toMatchObject({ threshold: 0.8, action: 'flag', source: 'default' });
  });

  it('PUT: admin can set threshold and action; a member cannot', async () => {
    const body = { categories: [{ category: 'spam', threshold: 0.6, action: 'hide' }] };
    const denied = await send('PUT', A, '/classifier/settings', member(A), body);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    const r = await send('PUT', A, '/classifier/settings', admin(A), body);
    expect(r.status).toBe(200);
    expect(
      r.body.categories.find((c: { category: string }) => c.category === 'spam'),
    ).toMatchObject({
      threshold: 0.6,
      action: 'hide',
      source: 'brand',
      updatedBy: { id: A.admin.userId, name: 'Test User' },
    });
    expect((await get(A, '/classifier/settings')).body.categories).toEqual(r.body.categories);
  });

  it.each([
    [{ category: 'spam', threshold: 1.2, action: 'flag' }, /between 0 and 1/],
    [{ category: 'spam', threshold: -0.1, action: 'flag' }, /between 0 and 1/],
    [{ category: 'spam', threshold: 0.12345, action: 'flag' }, /4 decimal places/],
    [{ category: 'spam', threshold: '0.5', action: 'flag' }, /number/],
    [{ category: 'spam', threshold: 0.5, action: 'nuke' }, /action/i],
  ])(
    'PUT rejects %j with 400 invalid_classifier_settings and a clear message',
    async (item, msg) => {
      const r = await send('PUT', A, '/classifier/settings', admin(A), { categories: [item] });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_classifier_settings');
      expect(JSON.stringify(r.body.error)).toMatch(msg);
      // The message and the issues are flat and name the category.
      expect(r.body.error.message).toMatch(/^spam: /);
      expect(r.body.error.issues).toEqual([
        {
          path: expect.stringMatching(/^categories\.0\./),
          message: expect.stringMatching(/^spam: /),
        },
      ]);
    },
  );

  it('PUT rejects duplicates, an empty list, unknown keys and unknown categories', async () => {
    const bad = [
      { categories: [] },
      {
        categories: [
          { category: 'spam', useDefault: true },
          { category: 'spam', useDefault: true },
        ],
      },
      { categories: [{ category: 'sentiment', threshold: 0.5, action: 'flag' }] },
      { categories: [{ category: 'spam', threshold: 0.5, action: 'flag' }], extra: 1 },
    ];
    for (const body of bad) {
      const r = await send('PUT', A, '/classifier/settings', admin(A), body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_classifier_settings');
    }
  });

  it('PUT records one audit event per changed category with before/after and the author', async () => {
    const o = await orgWithRoles(api, 'clfaud', {
      owner: A.owner,
      admin: A.admin,
      member: A.member,
    });
    const r = await send('PUT', o, '/classifier/settings', admin(o), {
      categories: [{ category: 'spam', threshold: 0.6, action: 'hide' }],
    });
    expect(r.status).toBe(200);
    const rows = await api.pool.query(
      `SELECT action, actor_user_id, subject_type, subject_id, details FROM audit_event
        WHERE brand_id = $1 AND action LIKE 'classifier_threshold.%' ORDER BY sequence`,
      [o.brandId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      action: 'classifier_threshold.updated',
      actor_user_id: o.admin.userId,
      subject_type: 'classifier_threshold',
      details: {
        category: 'spam',
        threshold_before: null,
        action_before: null,
        threshold_after: 0.6,
        action_after: 'hide',
      },
    });
  });

  it('PUT with an unchanged value audits nothing; useDefault resets and audits classifier_threshold.reset', async () => {
    const same = await send('PUT', A, '/classifier/settings', admin(A), {
      categories: [{ category: 'spam', threshold: 0.6, action: 'hide' }],
    });
    expect(same.status).toBe(200);
    const audits = () =>
      api.pool.query(
        `SELECT action, details FROM audit_event WHERE brand_id = $1 AND action LIKE 'classifier_threshold.%'
          ORDER BY sequence`,
        [A.brandId],
      );
    expect((await audits()).rowCount).toBe(1);
    const r = await send('PUT', A, '/classifier/settings', A.owner.cookie, {
      categories: [{ category: 'spam', useDefault: true }],
    });
    expect(r.status).toBe(200);
    expect(
      r.body.categories.find((c: { category: string }) => c.category === 'spam'),
    ).toMatchObject({ threshold: 0.8, action: 'flag', source: 'default', updatedBy: null });
    const rows = (await audits()).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      action: 'classifier_threshold.reset',
      details: {
        category: 'spam',
        threshold_before: 0.6,
        action_before: 'hide',
        threshold_after: null,
        action_after: null,
      },
    });
  });

  it('a threshold change does not create decisions or classifications for existing comments', async () => {
    await seedClassified(A, { spam: 0.7 });
    await seedClassified(A, { spam: 0.9 });
    const before = await counts(A);
    const r = await send('PUT', A, '/classifier/settings', admin(A), {
      categories: [{ category: 'spam', threshold: 0.1, action: 'remove' }],
    });
    expect(r.status).toBe(200);
    expect(await counts(A)).toEqual(before);
  });

  it('reads are open to members; every route answers 404 for an unknown brand', async () => {
    expect((await get(A, '/classifier/settings', member(A))).status).toBe(200);
    const url = `/api/v1/orgs/${A.orgId}/brands/${randomUUID()}/classifier/settings`;
    expect((await api.req('GET', url, { cookie: A.owner.cookie })).status).toBe(404);
    const bad = `/api/v1/orgs/${A.orgId}/brands/${A.brandId}/classifier/reruns/not-a-uuid`;
    expect((await api.req('GET', bad, { cookie: A.owner.cookie })).status).toBe(404);
  });
});

describe('classifier preview', () => {
  it('counts how outcomes would change and modifies nothing', async () => {
    await seedClassified(P, { spam: 0.7 });
    await seedClassified(P, { spam: 0.9 });
    await seedClassified(P, {});
    const before = await counts(P);
    const thresholds = await api.pool.query(
      'SELECT count(*)::int AS n FROM classifier_threshold WHERE brand_id = $1',
      [P.brandId],
    );
    const r = await send('POST', P, '/classifier/preview', member(P), {
      categories: [{ category: 'spam', threshold: 0.6, action: 'hide' }],
      days: 7,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      examined: 3,
      changed: 2,
      transitions: { 'none→hide': 1, 'flag→hide': 1 },
      capped: false,
    });
    expect(r.body.samples).toHaveLength(2);
    expect(Date.parse(r.body.window.to) - Date.parse(r.body.window.from)).toBe(7 * 86_400_000);
    expect(await counts(P)).toEqual(before);
    const after = await api.pool.query(
      'SELECT count(*)::int AS n FROM classifier_threshold WHERE brand_id = $1',
      [P.brandId],
    );
    expect(after.rows[0]).toEqual(thresholds.rows[0]);
  });

  it('days defaults to 7 and is bounded 1..30; bad thresholds are invalid_classifier_settings', async () => {
    const ok = await send('POST', P, '/classifier/preview', member(P), {
      categories: [{ category: 'spam', useDefault: true }],
    });
    expect(ok.status).toBe(200);
    expect(Date.parse(ok.body.window.to) - Date.parse(ok.body.window.from)).toBe(7 * 86_400_000);
    for (const days of [0, 31, 1.5]) {
      const r = await send('POST', P, '/classifier/preview', member(P), {
        categories: [{ category: 'spam', useDefault: true }],
        days,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_classifier_settings');
    }
    const bad = await send('POST', P, '/classifier/preview', member(P), {
      categories: [{ category: 'spam', threshold: 2, action: 'hide' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/between 0 and 1/);
  });
});

describe('classifier re-runs', () => {
  it('admin only: 202 with runId, one job per active connection on the lane, audited; a second within 15 minutes is 409', async () => {
    const connections = [
      (await api.seedConnection(R, { platform: 'facebook', externalAccountId: 'rr-fb-1' })).scope,
      (await api.seedConnection(R, { platform: 'instagram', externalAccountId: 'rr-ig-1' })).scope,
    ];
    const revoked = await api.seedConnection(R, {
      platform: 'facebook',
      externalAccountId: 'rr-x',
    });
    await api.pool.query("UPDATE connection SET status = 'revoked' WHERE id = $1", [
      revoked.scope.connectionId,
    ]);
    const spy = vi.spyOn(api.deps.producer!, 'enqueue');
    try {
      const denied = await send('POST', R, '/classifier/reruns', member(R), { days: 7 });
      expect(denied.status).toBe(403);
      expect(spy).not.toHaveBeenCalled();

      const r = await send('POST', R, '/classifier/reruns', admin(R), { days: 7 });
      expect(r.status).toBe(202);
      const runId = r.body.runId as string;
      const jobs = spy.mock.calls.map(([req]) => req).filter((q) => q.type === 'classifier_rerun');
      expect(jobs).toHaveLength(2);
      expect(jobs.map((q) => q.scope.connectionId).sort()).toEqual(
        connections.map((s) => s.connectionId).sort(),
      );
      const run = await api.pool.query(
        'SELECT days, since, requested_by_user_id FROM classifier_run WHERE id = $1 AND brand_id = $2',
        [runId, R.brandId],
      );
      expect(run.rows[0].days).toBe(7);
      expect(run.rows[0].requested_by_user_id).toBe(R.admin.userId);
      for (const q of jobs) {
        expect(q.payload).toEqual({ runId, since: run.rows[0].since.getTime() });
      }
      const audit = await api.pool.query(
        `SELECT actor_user_id, subject_type, subject_id, details FROM audit_event
          WHERE brand_id = $1 AND action = 'classifier.rerun_requested'`,
        [R.brandId],
      );
      expect(audit.rows).toEqual([
        {
          actor_user_id: R.admin.userId,
          subject_type: 'classifier_run',
          subject_id: runId,
          details: { days: 7 },
        },
      ]);

      spy.mockClear();
      const again = await send('POST', R, '/classifier/reruns', admin(R), { days: 7 });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('classifier_rerun_too_soon');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('is allowed again once the last run is older than 15 minutes', async () => {
    await api.pool.query(
      `UPDATE classifier_run SET created_at = now() - interval '16 minutes' WHERE brand_id = $1`,
      [R.brandId],
    );
    const r = await send('POST', R, '/classifier/reruns', admin(R), {});
    expect(r.status).toBe(202);
    const run = await api.pool.query('SELECT days FROM classifier_run WHERE id = $1', [
      r.body.runId,
    ]);
    expect(run.rows[0].days).toBe(7);
  });

  it('serialises concurrent requests: exactly one is accepted', async () => {
    await api.pool.query(
      `UPDATE classifier_run SET created_at = now() - interval '16 minutes' WHERE brand_id = $1`,
      [R.brandId],
    );
    const rs = await Promise.all(
      [1, 2, 3].map(() => send('POST', R, '/classifier/reruns', admin(R), { days: 3 })),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409, 409]);
  });

  it('bounds the window: days outside 1..30 is rejected and nothing is recorded', async () => {
    const before = await api.pool.query(
      'SELECT count(*)::int AS n FROM classifier_run WHERE brand_id = $1',
      [R.brandId],
    );
    for (const days of [0, 31, -1]) {
      const r = await send('POST', R, '/classifier/reruns', admin(R), { days });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_classifier_settings');
    }
    const after = await api.pool.query(
      'SELECT count(*)::int AS n FROM classifier_run WHERE brand_id = $1',
      [R.brandId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('keeps the run and reports counts when only some connections could be enqueued', async () => {
    const o = await orgWithRoles(api, 'clfpart', {
      owner: A.owner,
      admin: A.admin,
      member: A.member,
    });
    const ok = (await api.seedConnection(o, { platform: 'facebook', externalAccountId: 'pt-ok' }))
      .scope;
    const bad = (await api.seedConnection(o, { platform: 'facebook', externalAccountId: 'pt-bad' }))
      .scope;
    const spy = vi.spyOn(api.deps.producer!, 'enqueue').mockImplementation(async (req) => {
      if (req.scope.connectionId === bad.connectionId) throw new Error('redis down');
      return { status: 'enqueued' } as never;
    });
    try {
      const r = await send('POST', o, '/classifier/reruns', admin(o), { days: 4 });
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ runId: expect.any(String), enqueued: 1, failed: 1 });
      expect(spy.mock.calls.map(([q]) => q.scope.connectionId).sort()).toEqual(
        [ok.connectionId, bad.connectionId].sort(),
      );
      const run = await api.pool.query(
        'SELECT 1 FROM classifier_run WHERE id = $1 AND brand_id = $2',
        [r.body.runId, o.brandId],
      );
      expect(run.rowCount).toBe(1);
      const audit = await api.pool.query(
        `SELECT details FROM audit_event WHERE brand_id = $1 AND action = 'classifier.rerun_requested'`,
        [o.brandId],
      );
      expect(audit.rows).toEqual([{ details: { days: 4 } }]);
      spy.mockClear();
      const again = await send('POST', o, '/classifier/reruns', admin(o), { days: 4 });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('classifier_rerun_too_soon');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('still answers 503 when withdrawing the run fails', async () => {
    const o = await orgWithRoles(api, 'clfdel', {
      owner: A.owner,
      admin: A.admin,
      member: A.member,
    });
    await api.seedConnection(o, { platform: 'facebook', externalAccountId: 'del-1' });
    const enq = vi.spyOn(api.deps.producer!, 'enqueue').mockRejectedValue(new Error('redis down'));
    const del = vi.spyOn(api.pool, 'query');
    try {
      del.mockImplementation(((sql: unknown, ...rest: unknown[]) =>
        typeof sql === 'string' && sql.startsWith('DELETE FROM classifier_run')
          ? Promise.reject(new Error('db down'))
          : (del.getMockImplementation() as never) &&
            Reflect.apply(Object.getPrototypeOf(api.pool).query, api.pool, [
              sql,
              ...rest,
            ])) as never);
      const r = await send('POST', o, '/classifier/reruns', admin(o), { days: 2 });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('temporarily_unavailable');
    } finally {
      del.mockRestore();
      enq.mockRestore();
    }
  });

  it('withdraws the run when the queue refuses, so the caller can retry at once', async () => {
    await api.pool.query(
      `UPDATE classifier_run SET created_at = now() - interval '16 minutes' WHERE brand_id = $1`,
      [R.brandId],
    );
    const spy = vi.spyOn(api.deps.producer!, 'enqueue').mockRejectedValue(new Error('redis down'));
    try {
      const before = await api.pool.query(
        'SELECT count(*)::int AS n FROM classifier_run WHERE brand_id = $1',
        [R.brandId],
      );
      const r = await send('POST', R, '/classifier/reruns', admin(R), { days: 2 });
      expect(r.status).toBe(503);
      const after = await api.pool.query(
        'SELECT count(*)::int AS n FROM classifier_run WHERE brand_id = $1',
        [R.brandId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      spy.mockRestore();
    }
    const retry = await send('POST', R, '/classifier/reruns', admin(R), { days: 2 });
    expect(retry.status).toBe(202);
  });

  it('GET reruns/:runId reports counts by status from comment_classification', async () => {
    const created = await send('POST', P, '/classifier/reruns', admin(P), { days: 5 });
    expect(created.status).toBe(202);
    const runId = created.body.runId as string;
    const trigger = `rerun:${runId}`;
    await seedClassified(P, { spam: 0.2 }, { triggerKey: trigger });
    await seedClassified(P, { spam: 0.9 }, { triggerKey: trigger });
    await seedClassified(P, {}, { triggerKey: trigger, status: 'unclassified' });
    await seedClassified(P, { spam: 0.9 }); // ingest, not part of the run
    const r = await get(P, `/classifier/reruns/${runId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: runId,
      days: 5,
      counts: { classified: 2, unclassified: 1, skipped: 0 },
    });
    expect(Date.parse(r.body.createdAt) - Date.parse(r.body.since)).toBeGreaterThan(
      5 * 86_400_000 - 60_000,
    );
    expect((await get(P, `/classifier/reruns/${randomUUID()}`)).status).toBe(404);
    // A run of another brand is not visible, even to the same user.
    expect((await get(A, `/classifier/reruns/${runId}`)).status).toBe(404);
  });
});

describe('classification and the decision log', () => {
  it('GET comments/:id/classification returns scores and flags; null when not classified', async () => {
    const classified = await seedClassified(P, { hate_speech: 0.93 });
    const r = await get(P, `/comments/${classified.commentId}/classification`);
    expect(r.status).toBe(200);
    expect(r.body.classification).toMatchObject({
      status: 'classified',
      provider: 'fake',
      model: 'fake-1',
      language: 'en',
      languageSupported: true,
      lowSignal: false,
      ruleDecided: false,
      outcome: 'hide',
      downgraded: null,
      scores: { hate_speech: 0.93, spam: 0 },
      triggers: [{ category: 'hate_speech', score: 0.93, threshold: 0.8, action: 'hide' }],
    });
    const none = await seedClassified(P, null);
    const empty = await get(P, `/comments/${none.commentId}/classification`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ classification: null });
    expect((await get(P, `/comments/${randomUUID()}/classification`)).status).toBe(404);
    expect((await get(A, `/comments/${classified.commentId}/classification`)).status).toBe(404);
  });

  it('decisions and activity include classifier decisions with category, score, threshold and triggers', async () => {
    const { commentId } = await seedClassified(P, { hate_speech: 0.93 });
    const r = await get(P, `/comments/${commentId}/decisions`);
    expect(r.status).toBe(200);
    expect(r.body.decisions).toHaveLength(1);
    expect(r.body.decisions[0]).toMatchObject({
      actorType: 'classifier',
      outcome: 'hide',
      mode: 'enforce',
      rule: null,
      fallback: false,
      classifier: {
        category: 'hate_speech',
        score: 0.93,
        threshold: 0.8,
        provider: 'fake',
        model: 'fake-1',
        downgraded: null,
        reversal: false,
        triggers: [{ category: 'hate_speech', score: 0.93, threshold: 0.8 }],
      },
    });
    const act = await get(P, '/rule-activity?source=classifier');
    expect(act.status).toBe(200);
    expect(act.body.items.length).toBeGreaterThan(0);
    expect(act.body.items.every((i: { actorType: string }) => i.actorType === 'classifier')).toBe(
      true,
    );
    const byCategory = await get(P, '/rule-activity?source=classifier&category=hate_speech');
    expect(byCategory.body.items.map((i: { commentId: string }) => i.commentId)).toContain(
      commentId,
    );
    const other = await get(P, '/rule-activity?source=classifier&category=profanity');
    expect(other.body.items).toEqual([]);
    expect((await get(P, '/rule-activity?source=nobody')).status).toBe(400);
    expect((await get(P, '/rule-activity?category=nope')).status).toBe(400);
  });

  it('rule-activity default lists rule and classifier decisions; source=rule lists rules only', async () => {
    const created = await send('POST', P, '/rules', admin(P), {
      name: 'regression rule',
      conditions: { type: 'keyword', terms: ['zzz'] },
      action: 'flag',
    });
    expect(created.status).toBe(201);
    const { commentId } = await seedClassified(P, null);
    await api.pool.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason)
       VALUES ($1, $2, $3, 'flag', 'suggest', 'rule', $4, 'Rule matched')`,
      [P.orgId, P.brandId, commentId, created.body.id],
    );
    const all = await get(P, '/rule-activity?limit=100');
    const actors = new Set(all.body.items.map((i: { actorType: string }) => i.actorType));
    expect(actors).toEqual(new Set(['rule', 'classifier']));
    const rules = await get(P, '/rule-activity?source=rule');
    expect(rules.body.items.length).toBeGreaterThan(0);
    expect(rules.body.items.every((i: { actorType: string }) => i.actorType === 'rule')).toBe(true);
    expect(rules.body.items[0].classifier).toBeNull();
    expect(rules.body.items[0].rule).toMatchObject({ id: created.body.id });
  });

  it('marks a reversal (approve below the threshold) and a fallback flag', async () => {
    const classificationOf = async (commentId: string) =>
      (
        await api.pool.query('SELECT id FROM comment_classification WHERE comment_id = $1', [
          commentId,
        ])
      ).rows[0].id as string;
    const scope = { organizationId: P.orgId, brandId: P.brandId };

    const reversed = await seedClassified(P, { hate_speech: 0.93 });
    expect(
      await store.recordReversal(
        scope,
        await classificationOf(reversed.commentId),
        'hate_speech',
        0.3,
        0.8,
        'Restored: the score fell below the threshold',
      ),
    ).toBe(true);
    const rev = await get(P, `/comments/${reversed.commentId}/decisions`);
    expect(rev.body.decisions[0]).toMatchObject({
      outcome: 'approve',
      actorType: 'classifier',
      fallback: false,
      classifier: { category: 'hate_speech', score: 0.3, threshold: 0.8, reversal: true },
    });
    expect(rev.body.decisions[1].classifier.reversal).toBe(false);

    const flagged = await seedClassified(P, { scam_phishing: 0.9 });
    expect(
      await store.recordFallback(
        scope,
        await classificationOf(flagged.commentId),
        'hide_failed',
        'Flagged for review: the classifier could not hide this comment',
      ),
    ).toBe(true);
    const fb = await get(P, `/comments/${flagged.commentId}/decisions`);
    expect(fb.body.decisions[0]).toMatchObject({
      outcome: 'flag',
      fallback: true,
      classifier: { category: 'scam_phishing', score: 0.9, reversal: false },
    });
    expect(fb.body.decisions[1].fallback).toBe(false);
  });

  it('populates the decision action through the clf:<id> and clf:<id>:unhide request keys', async () => {
    const { commentId, scope } = await seedClassified(P, { hate_speech: 0.93 });
    const cid = (
      await api.pool.query('SELECT id FROM comment_classification WHERE comment_id = $1', [
        commentId,
      ])
    ).rows[0].id as string;
    const action = (key: string, kind: string, status: string, code: string) =>
      api.pool.query(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
           actor_type, request_key, status, outcome_code, completed_at)
         VALUES ($1, $2, $3, $4, $5, 'classifier', $6, $7, $8, now())`,
        [
          scope.organizationId,
          scope.brandId,
          scope.connectionId,
          commentId,
          kind,
          key,
          status,
          code,
        ],
      );
    await action(`clf:${cid}`, 'hide', 'applied', 'ok');
    const hidden = await get(P, `/comments/${commentId}/decisions`);
    expect(hidden.body.decisions[0].action).toEqual({
      kind: 'hide',
      status: 'applied',
      outcomeCode: 'ok',
    });
    await store.recordReversal(
      { organizationId: P.orgId, brandId: P.brandId },
      cid,
      'hate_speech',
      0.3,
      0.8,
      'Restored: the score fell below the threshold',
    );
    await action(`clf:${cid}:unhide`, 'unhide', 'applied', 'restored');
    const after = await get(P, `/comments/${commentId}/decisions`);
    expect(after.body.decisions[0]).toMatchObject({
      outcome: 'approve',
      action: { kind: 'unhide', status: 'applied', outcomeCode: 'restored' },
    });
    expect(after.body.decisions[1].action).toMatchObject({ kind: 'hide' });
  });

  it('a classifier decision on the comment list is the latest decision with its evidence', async () => {
    const { commentId } = await seedClassified(P, { scam_phishing: 0.95 });
    const list = await get(P, '/comments?limit=100');
    const c = list.body.comments.find((x: { id: string }) => x.id === commentId);
    expect(c.latestDecision).toMatchObject({
      actorType: 'classifier',
      classifier: { category: 'scam_phishing', score: 0.95 },
    });
  });
});
