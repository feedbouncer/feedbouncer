// Action capabilities, rule action validation, simulation, the action log, undo and the review
// queue over the API. Platform calls are not made: accepted actions only reach the job queue.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgActionRunStore, PgReviewQueue, type ActionStep } from '@feedbouncer/actions';
import { withTransaction } from '@feedbouncer/db';
import { Secret } from '@feedbouncer/service-runtime';
import { ActionsService } from './actions.service.js';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

let api: TestApi;
let fb: OrgFixture;
let ig: OrgFixture;
let seq = 0;

const base = (o: { orgId: string; brandId: string }) =>
  `/api/v1/orgs/${o.orgId}/brands/${o.brandId}`;
const call = (o: OrgFixture, method: string, path: string, body?: unknown, cookie?: string) =>
  api.req(method, `${base(o)}${path}`, {
    cookie: cookie ?? o.owner.cookie,
    ...(body !== undefined && { body }),
  });

const keyword = { type: 'keyword', terms: ['zq-actions'] };
const rule = (actions: unknown, name = `rule ${++seq}`) => ({ name, conditions: keyword, actions });

const count = async (table: string) =>
  Number((await api.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

interface Seeded {
  connectionId: string;
  commentId: string;
  ruleId: string;
}

/** A Facebook connection with a comment and a rule, in the organization's brand. */
async function seedBase(o: { orgId: string; brandId: string }, state = 'visible'): Promise<Seeded> {
  const { scope } = await api.seedFacebookConnection(o);
  const n = ++seq;
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [o.orgId, o.brandId, scope.connectionId, `1_${n}`],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                          platform_state, posted_at)
     VALUES ($1, $2, $3, $4, $5, 'secret body', $6, now()) RETURNING id`,
    [o.orgId, o.brandId, scope.connectionId, source.rows[0].id, `1_${n}_1`, state],
  );
  const r = await api.pool.query(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, mode)
     VALUES ($1, $2, $3, $4::jsonb, 'flag', 'enforce') RETURNING id`,
    [o.orgId, o.brandId, `seeded ${n}`, JSON.stringify(keyword)],
  );
  return {
    connectionId: scope.connectionId,
    commentId: comment.rows[0].id,
    ruleId: r.rows[0].id,
  };
}

/** A settled, live step of a run; hide and delete steps are linked to an applied rule action. */
async function seedStep(
  o: { orgId: string; brandId: string },
  s: Seeded,
  step: ActionStep,
): Promise<{ stepId: string; reviewItemId: string | null }> {
  const scope = { organizationId: o.orgId, brandId: o.brandId, connectionId: s.connectionId };
  const evaluation = await api.pool.query(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                  trigger_key, ruleset_version, status)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), $5, 'v1', 'no_match') RETURNING id`,
    [o.orgId, o.brandId, s.connectionId, s.commentId, `t-${randomUUID().slice(0, 12)}`],
  );
  const runs = new PgActionRunStore(api.pool);
  const run = await runs.createRun(scope, {
    commentId: s.commentId,
    ruleId: s.ruleId,
    evaluationId: evaluation.rows[0].id,
    dryRun: false,
    steps: [step],
  });
  const stepId = run.steps[0]!.id;
  return withTransaction(api.pool, async (client) => {
    let reviewItemId: string | null = null;
    if (step.type === 'hide' || step.type === 'delete') {
      const action = await client.query(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                        actor_type, request_key, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, 'rule', $6, 'applied', now()) RETURNING id`,
        [o.orgId, o.brandId, s.connectionId, s.commentId, step.type, `auto:${stepId}`],
      );
      await runs.linkAction(client, scope, stepId, action.rows[0].id, `auto:${stepId}`);
    }
    if (step.type === 'flag_for_review')
      reviewItemId = (
        await new PgReviewQueue(api.pool).open(client, scope, {
          commentId: s.commentId,
          source: 'action_step',
          ruleId: s.ruleId,
        })
      ).id;
    await runs.settleStep(client, scope, stepId, {
      status: 'succeeded',
      reason: null,
      ...(reviewItemId && { reviewItemId }),
    });
    return { stepId, reviewItemId };
  });
}

async function openItem(o: { orgId: string; brandId: string }, s: Seeded): Promise<string> {
  const r = await api.pool.query(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, rule_id)
     VALUES ($1, $2, $3, $4, 'action_step', $5) RETURNING id`,
    [o.orgId, o.brandId, s.connectionId, s.commentId, s.ruleId],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK, instagram: { meta: FACEBOOK } });
  fb = await orgWithRoles(api, 'actions');
  ig = await orgWithRoles(api, 'actionsig', fb);
  const { scope } = await api.seedFacebookConnection(fb);
  await api.pool.query('UPDATE connection SET granted_scopes = $2 WHERE id = $1', [
    scope.connectionId,
    api.deps.connectors!.registry.get('facebook')!.capabilities.defaultScopes,
  ]);
  await api.seedConnection(ig, { platform: 'instagram', externalAccountId: '17841400000000001' });
});
afterAll(() => api.close());

describe('action capabilities', () => {
  it('lists every step with its meta and per-connection support', async () => {
    const r = await call(fb, 'GET', '/action-capabilities', undefined, fb.member.cookie);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.steps).sort()).toEqual(
      ['auto_reply', 'ban', 'delete', 'flag_for_review', 'hide', 'private_reply'].sort(),
    );
    expect(r.body.steps.delete.meta).toMatchObject({
      reversibility: 'irreversible',
      destructive: true,
    });
    expect(r.body.steps.hide.platforms).toEqual([
      expect.objectContaining({ platform: 'facebook', supported: true, missingScopes: [] }),
    ]);
    const igCaps = await call(ig, 'GET', '/action-capabilities');
    expect(igCaps.body.steps.ban.platforms).toEqual([
      expect.objectContaining({ platform: 'instagram', supported: false }),
    ]);
    expect(igCaps.body.steps.private_reply.platforms[0].missingScopes).toEqual([
      'instagram_manage_messages',
    ]);
    expect(igCaps.body.steps.auto_reply.platforms[0].maxChars).toBeGreaterThan(0);
  });
});

describe('rule actions', () => {
  it('rejects a ban on a brand whose platforms cannot ban', async () => {
    const r = await call(ig, 'POST', '/rules', rule([{ type: 'ban', confirmHardToReverse: true }]));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('invalid_actions');
    expect(r.body.error.issues).toEqual([{ path: 'actions.0', message: 'not_supported_anywhere' }]);
  });

  it('lets the terms of a rule be edited when its saved steps no longer fit the brand', async () => {
    const ban = [{ type: 'ban', confirmHardToReverse: true }];
    const saved = await api.pool.query(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions, mode)
       VALUES ($1, $2, 'stale ban', $3::jsonb, 'hide', $4::jsonb, 'enforce') RETURNING id`,
      [ig.orgId, ig.brandId, JSON.stringify(keyword), JSON.stringify(ban)],
    );
    const ruleId = saved.rows[0].id;
    const terms = await call(ig, 'PATCH', `/rules/${ruleId}`, {
      conditions: { type: 'keyword', terms: ['zq-edited'] },
    });
    expect(terms.status).toBe(200);
    const steps = await call(ig, 'PATCH', `/rules/${ruleId}`, { actions: ban });
    expect(steps.status).toBe(422);
  });

  it('rejects a delete without its confirmation and a conflicting pair', async () => {
    const del = await call(fb, 'POST', '/rules', rule([{ type: 'delete' }]));
    expect(del.status).toBe(422);
    expect(del.body.error.code).toBe('invalid_actions');
    expect(del.body.error.issues[0].path).toBe('actions.0.confirmIrreversible');
    const pair = await call(
      fb,
      'POST',
      '/rules',
      rule([{ type: 'hide' }, { type: 'auto_reply', template: 'hi' }]),
    );
    expect(pair.status).toBe(422);
    expect(pair.body.error.issues).toEqual([
      { path: 'actions.0', message: 'reply_to_hidden_comment' },
    ]);
  });

  it('rejects a template longer than a platform allows', async () => {
    const r = await call(
      ig,
      'POST',
      '/rules',
      rule([{ type: 'private_reply', template: 'x'.repeat(1100) }]),
    );
    expect(r.status).toBe(422);
    expect(r.body.error.issues[0]).toMatchObject({
      path: 'actions.0',
      message: 'template_too_long',
      platform: 'instagram',
      max: 1000,
    });
  });

  it('saves a private reply that lacks a permission, with a warning', async () => {
    const r = await call(ig, 'POST', '/rules', rule([{ type: 'private_reply', template: 'hi' }]));
    expect(r.status).toBe(201);
    expect(r.body.actions).toEqual([{ type: 'private_reply', template: 'hi' }]);
    expect(r.body.actionWarnings).toEqual([
      expect.objectContaining({
        type: 'private_reply',
        code: 'missing_permission',
        platform: 'instagram',
        scopes: ['instagram_manage_messages'],
      }),
    ]);
    const patched = await call(ig, 'PATCH', `/rules/${r.body.id}`, { enabled: false });
    expect(patched.body.actionWarnings).toHaveLength(1);
  });

  it('checks a patch against the brand and leaves the rule unchanged on failure', async () => {
    const created = await call(fb, 'POST', '/rules', rule([{ type: 'hide' }]));
    expect(created.status).toBe(201);
    expect(created.body.actionWarnings).toEqual([]);
    const other = await call(ig, 'POST', '/rules', rule([{ type: 'hide' }]));
    const r = await call(ig, 'PATCH', `/rules/${other.body.id}`, {
      actions: [{ type: 'ban', confirmHardToReverse: true }],
    });
    expect(r.status).toBe(422);
    expect((await call(ig, 'GET', `/rules/${other.body.id}`)).body.actions).toEqual([
      { type: 'hide' },
    ]);
  });

  it('refuses the legacy action key', async () => {
    const created = await call(fb, 'POST', '/rules', rule([{ type: 'hide' }]));
    const patch = await call(fb, 'PATCH', `/rules/${created.body.id}`, { action: 'flag' });
    expect(patch.status).toBe(400);
    const post = await call(fb, 'POST', '/rules', { ...rule([]), action: 'flag' });
    expect(post.status).toBe(400);
  });

  it('lets a member read capabilities but not edit rule actions', async () => {
    const created = await call(fb, 'POST', '/rules', rule([{ type: 'hide' }]));
    const m = fb.member.cookie;
    const patch = await call(fb, 'PATCH', `/rules/${created.body.id}`, { actions: [] }, m);
    expect(patch.status).toBe(403);
    expect((await call(fb, 'POST', '/rules', rule([]), m)).status).toBe(403);
  });
});

describe('simulate', () => {
  it('predicts each step and writes nothing', async () => {
    const s = await seedBase(fb);
    const created = await call(
      fb,
      'POST',
      '/rules',
      rule([{ type: 'private_reply', template: 'hello {{brand_name}}' }, { type: 'hide' }]),
    );
    const tables = [
      'action_run',
      'action_run_step',
      'moderation_action',
      'review_item',
      'job_ledger',
    ];
    const before = await Promise.all(tables.map(count));
    const r = await call(
      fb,
      'POST',
      `/rules/${created.body.id}/simulate`,
      { commentId: s.commentId },
      fb.member.cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.steps.map((x: { type: string }) => x.type)).toEqual(['private_reply', 'hide']);
    expect(r.body.steps[0].previewText).toMatch(/^hello /);
    expect(r.body.steps[1]).toMatchObject({ type: 'hide', previewText: null });
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  it('needs no job producer', async () => {
    const s = await seedBase(fb);
    const created = await call(fb, 'POST', '/rules', rule([{ type: 'hide' }]));
    const service = new ActionsService({ ...api.deps, producer: null });
    const org = {
      organizationId: fb.orgId,
      actorUserId: fb.member.userId,
      role: 'member',
      grants: [],
    } as const;
    const r = await service.simulate(org, fb.brandId, created.body.id, s.commentId);
    expect(r.steps.map((x) => x.type)).toEqual(['hide']);
  });

  it('is a 404 for an unknown rule or comment and a 400 for a bad body', async () => {
    const s = await seedBase(fb);
    const created = await call(fb, 'POST', '/rules', rule([{ type: 'hide' }]));
    const sim = (rid: string, body: unknown) => call(fb, 'POST', `/rules/${rid}/simulate`, body);
    expect((await sim(randomUUID(), { commentId: s.commentId })).status).toBe(404);
    expect((await sim(created.body.id, { commentId: randomUUID() })).status).toBe(404);
    expect((await sim(created.body.id, { commentId: 'nope' })).status).toBe(400);
    expect((await sim(created.body.id, {})).status).toBe(400);
  });
});

describe('action log and undo', () => {
  it('action-log row exposes deferredUntil/deferredCode for a deferred reply', async () => {
    const s = await seedBase(fb);
    const { stepId } = await seedStep(fb, s, { type: 'auto_reply', template: 'Thanks!' });
    const until = new Date(Date.now() + 15 * 60_000);
    await withTransaction(api.pool, async (client) => {
      const action = await client.query(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                        actor_type, request_key, status, reply_text, deferred_until, deferred_code)
         VALUES ($1, $2, $3, $4, 'public_reply', 'rule', $5, 'pending', 'Thanks!', $6, 'reply_quota_exhausted')
         RETURNING id`,
        [fb.orgId, fb.brandId, s.connectionId, s.commentId, `auto:${stepId}`, until],
      );
      await client.query(
        'UPDATE action_run_step SET moderation_action_id = $3 WHERE brand_id = $1 AND id = $2',
        [fb.brandId, stepId, action.rows[0].id],
      );
    });
    const list = await call(fb, 'GET', `/action-log?commentId=${s.commentId}`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({
      id: stepId,
      deferredUntil: until.toISOString(),
      deferredCode: 'reply_quota_exhausted',
    });
  });

  it('action-log row has no deferral for a settled action', async () => {
    const s = await seedBase(fb, 'hidden');
    await seedStep(fb, s, { type: 'hide' });
    const list = await call(fb, 'GET', `/action-log?commentId=${s.commentId}`);
    expect(list.body.items[0]).toMatchObject({ deferredUntil: null, deferredCode: null });
  });

  it('lists steps without request keys and undoes a hide once', async () => {
    const s = await seedBase(fb, 'hidden');
    const { stepId } = await seedStep(fb, s, { type: 'hide' });
    const list = await call(
      fb,
      'GET',
      `/action-log?commentId=${s.commentId}&type=hide&status=succeeded&ruleId=${s.ruleId}`,
      undefined,
      fb.member.cookie,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: stepId, type: 'hide', undoable: true });
    expect(JSON.stringify(list.body)).not.toContain('auto:');

    const undo = await call(fb, 'POST', `/action-log/${stepId}/undo`, {}, fb.member.cookie);
    expect(undo.status).toBe(202);
    expect(undo.body.status).toBe('accepted');
    expect(undo.body.undoActionId).toEqual(expect.any(String));
    const again = await call(fb, 'POST', `/action-log/${stepId}/undo`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_undone');
    const after = await call(fb, 'GET', `/action-log?commentId=${s.commentId}`);
    expect(after.body.items[0]).toMatchObject({ undoable: false });
    const audit = await api.pool.query(
      "SELECT 1 FROM audit_event WHERE action = 'action_step.undone' AND subject_id = $1",
      [stepId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('refuses to undo a delete and answers 404 for an unknown step', async () => {
    const s = await seedBase(fb);
    const { stepId } = await seedStep(fb, s, { type: 'delete', confirmIrreversible: true });
    const r = await call(fb, 'POST', `/action-log/${stepId}/undo`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('undo_not_available');
    expect((await call(fb, 'POST', `/action-log/${randomUUID()}/undo`, {})).status).toBe(404);
    expect((await call(fb, 'POST', '/action-log/nope/undo', {})).status).toBe(404);
  });

  it('dismisses the review item when a flag is undone', async () => {
    const s = await seedBase(fb);
    const { stepId, reviewItemId } = await seedStep(fb, s, { type: 'flag_for_review' });
    const r = await call(fb, 'POST', `/action-log/${stepId}/undo`, {});
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'done', undoActionId: null });
    const item = await api.pool.query('SELECT resolution FROM review_item WHERE id = $1', [
      reviewItemId,
    ]);
    expect(item.rows[0].resolution).toBe('dismissed');
  });

  it('pages by the last step id and rejects bad filters', async () => {
    const s = await seedBase(fb);
    await seedStep(fb, s, { type: 'flag_for_review' });
    await seedStep(fb, s, { type: 'flag_for_review' });
    expect((await call(fb, 'GET', '/action-log?limit=101')).status).toBe(400);
    expect((await call(fb, 'GET', '/action-log?status=nope')).status).toBe(400);
    const page = await call(fb, 'GET', `/action-log?limit=1&commentId=${s.commentId}`);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.next).toBe(page.body.items[0].id);
    const next = await call(
      fb,
      'GET',
      `/action-log?limit=1&commentId=${s.commentId}&before=${page.body.next}`,
    );
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    expect(next.body.next).toBeNull();
    const all = await call(fb, 'GET', `/action-log?limit=2&commentId=${s.commentId}`);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.next).toBeNull();
  });
});

describe('review queue', () => {
  it('lists open and resolved items with the comment', async () => {
    const s = await seedBase(fb);
    const id = await openItem(fb, s);
    const open = await call(fb, 'GET', '/review-items?status=open', undefined, fb.member.cookie);
    expect(open.status).toBe(200);
    expect(open.body.items.find((i: { id: string }) => i.id === id)).toMatchObject({
      commentId: s.commentId,
      status: 'open',
      commentBody: 'secret body',
      platform: 'facebook',
    });
    const resolve = await call(fb, 'POST', `/review-items/${id}/resolve`, {
      resolution: 'approve',
      requestKey: `rv-${id}`,
    });
    expect(resolve.status).toBe(200);
    expect(resolve.body).toEqual({ resolution: 'approve', actionId: null });
    const done = await call(fb, 'GET', '/review-items?status=resolved');
    expect(done.body.items.map((i: { id: string }) => i.id)).toContain(id);
    expect((await call(fb, 'GET', '/review-items')).status).toBe(400);
    expect((await call(fb, 'GET', '/review-items?status=open&limit=0')).status).toBe(400);
  });

  it('requires confirmation for delete and ban', async () => {
    const s = await seedBase(fb);
    const id = await openItem(fb, s);
    const path = `/review-items/${id}/resolve`;
    const no = await call(fb, 'POST', path, { resolution: 'delete', requestKey: `rv-${id}` });
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe('confirmation_required');
    const wrong = await call(fb, 'POST', path, {
      resolution: 'delete',
      requestKey: `rv-${id}`,
      confirm: false,
    });
    expect(wrong.status).toBe(400);
    const yes = await call(
      fb,
      'POST',
      path,
      { resolution: 'delete', requestKey: `rv-${id}`, confirm: true },
      fb.member.cookie,
    );
    expect(yes.status).toBe(200);
    expect(yes.body).toEqual({ resolution: 'delete', actionId: expect.any(String) });
    const again = await call(fb, 'POST', path, { resolution: 'approve', requestKey: `rv2-${id}` });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('review_item_resolved');
    const audit = await api.pool.query(
      "SELECT 1 FROM audit_event WHERE action = 'review_item.resolved' AND subject_id = $1",
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('refuses request keys in the server-derived space and unknown bodies', async () => {
    const s = await seedBase(fb);
    const id = await openItem(fb, s);
    const path = `/review-items/${id}/resolve`;
    for (const requestKey of [
      'auto:x',
      'undo:x',
      'review:x',
      'clf:x',
      'pol:x',
      'rule-eval:x',
      'bad key',
    ])
      expect((await call(fb, 'POST', path, { resolution: 'hide', requestKey })).status).toBe(400);
    expect((await call(fb, 'POST', path, { resolution: 'hide' })).status).toBe(400);
    expect(
      (await call(fb, 'POST', path, { resolution: 'hide', requestKey: 'k1', extra: 1 })).status,
    ).toBe(400);
    const unknown = await call(fb, 'POST', `/review-items/${randomUUID()}/resolve`, {
      resolution: 'hide',
      requestKey: 'k1',
    });
    expect(unknown.status).toBe(404);
  });

  it('refuses a reserved request key on the comment action endpoint too', async () => {
    const s = await seedBase(fb);
    const r = await call(fb, 'POST', `/comments/${s.commentId}/actions`, {
      kind: 'hide',
      requestKey: 'auto:abc',
    });
    expect(r.status).toBe(400);
  });
});

describe('another brand of the same organization', () => {
  it('cannot reach steps, review items or rules through this brand', async () => {
    const other = (
      await api.pool.query(
        "INSERT INTO brand (organization_id, name) VALUES ($1, 'second') RETURNING id",
        [fb.orgId],
      )
    ).rows[0].id as string;
    const o = { orgId: fb.orgId, brandId: other };
    const s = await seedBase(o, 'hidden');
    const { stepId } = await seedStep(o, s, { type: 'hide' });
    const itemId = await openItem(o, s);
    const sim = await call(fb, 'POST', `/rules/${s.ruleId}/simulate`, { commentId: s.commentId });
    expect(sim.status).toBe(404);
    const undo = await call(fb, 'POST', `/action-log/${stepId}/undo`, {});
    expect(undo.status).toBe(404);
    const resolve = await call(fb, 'POST', `/review-items/${itemId}/resolve`, {
      resolution: 'approve',
      requestKey: 'k1',
    });
    expect(resolve.status).toBe(404);
    for (const path of ['/action-log', '/review-items?status=open'])
      expect(JSON.stringify((await call(fb, 'GET', path)).body)).not.toContain(s.commentId);
  });
});
