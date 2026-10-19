// Reviewing rule changes proposed through the public API: only a person signed in to the
// dashboard with rule.write can approve or reject them.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys } from '@feedbouncer/public-api';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

let api: TestApi;
let A: OrgFixture;
let B: OrgFixture;
let writerA: string;
let ipCounter = 0;

async function newKey(org: OrgFixture): Promise<string> {
  const { token } = await new PgApiKeys(api.pool).create(org.orgId, org.owner.userId, {
    name: `k-${randomUUID()}`,
    scope: 'write',
  });
  return token.reveal();
}

const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  'x-forwarded-for': `203.0.113.${(++ipCounter % 250) + 1}`,
});

async function propose(body: object, org: OrgFixture = A, token = writerA): Promise<string> {
  const r = await api.req('POST', '/v1/rule-change-proposals', {
    headers: bearer(token),
    body: { brandId: org.brandId, ...body },
  });
  if (r.status !== 201) throw new Error(`propose failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

const newRule = (name: string) => ({
  name,
  conditions: { type: 'keyword', terms: [name] },
  actions: [{ type: 'hide' }],
  mode: 'enforce',
});
const proposeCreate = (name: string) =>
  propose({ operation: 'create', rule: newRule(name), rationale: 'Seen a lot of these' });

const base = (o: OrgFixture = A) => `/api/v1/orgs/${o.orgId}/brands/${o.brandId}`;
const changes = (id = '', o: OrgFixture = A) => `${base(o)}/rule-changes${id && `/${id}`}`;
const approve = (id: string, cookie = A.admin.cookie, body?: object) =>
  api.req('POST', `${changes(id)}/approve`, { cookie, body: body ?? {} });
const reject = (id: string, cookie = A.admin.cookie, body?: object) =>
  api.req('POST', `${changes(id)}/reject`, { cookie, body: body ?? {} });

async function createRule(name: string): Promise<string> {
  const r = await api.req('POST', `${base()}/rules`, {
    cookie: A.owner.cookie,
    body: {
      name,
      conditions: { type: 'keyword', terms: [name] },
      actions: [{ type: 'flag_for_review' }],
    },
  });
  if (r.status !== 201) throw new Error(`rule create failed: ${r.status}`);
  return r.body.id as string;
}

async function liveRules(): Promise<{ id: string; name: string; enabled: boolean }[]> {
  const { rows } = await api.pool.query(
    `SELECT id, name, enabled FROM rule WHERE brand_id = $1 AND archived_at IS NULL ORDER BY id`,
    [A.brandId],
  );
  return rows;
}

async function proposalRow(id: string) {
  const { rows } = await api.pool.query(
    `SELECT status, decided_by_user_id, decided_at, decision_note, applied_rule_id
       FROM rule_change_proposal WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function audits(subjectId: string) {
  const { rows } = await api.pool.query<{
    action: string;
    actor_user_id: string | null;
    details: Record<string, unknown>;
  }>(
    `SELECT action, actor_user_id, details FROM audit_event
      WHERE organization_id = $1 AND subject_id = $2 ORDER BY sequence`,
    [A.orgId, subjectId],
  );
  return rows;
}

beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  A = await orgWithRoles(api, 'rcA');
  B = await orgWithRoles(api, 'rcB');
  writerA = await newKey(A);
});
afterAll(() => api.close());

describe('rule changes', () => {
  it('lists and shows proposals with who proposed them and whether they are stale', async () => {
    const id = await proposeCreate('listed');
    const list = await api.req('GET', changes(), { cookie: A.member.cookie });
    expect(list.status).toBe(200);
    expect(list.body.changes.map((c: { id: string }) => c.id)).toContain(id);

    const one = await api.req('GET', changes(id), { cookie: A.member.cookie });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      id,
      operation: 'create',
      ruleId: null,
      status: 'pending',
      before: null,
      after: expect.objectContaining({ name: 'listed', mode: 'enforce' }),
      warnings: [],
      rationale: 'Seen a lot of these',
      isStale: false,
      proposedBy: { apiKeyName: expect.stringMatching(/^k-/) },
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    });
    expect(one.body.diff).toEqual(
      expect.arrayContaining([{ field: 'name', before: null, after: 'listed' }]),
    );
    expect(one.body.currentRuleRevision).toBe(one.body.baseRuleRevision);

    const rejected = await api.req('GET', `${changes()}?status=rejected`, {
      cookie: A.member.cookie,
    });
    expect(rejected.body.changes.map((c: { id: string }) => c.id)).not.toContain(id);
    expect(
      (await api.req('GET', `${changes()}?status=nope`, { cookie: A.member.cookie })).status,
    ).toBe(400);
    await reject(id);
  });

  it('admin approves create → rule exists with proposal conditions; proposal approved; audit rule_change.approved + rule.created', async () => {
    const id = await proposeCreate('giveaway');
    const r = await approve(id, A.admin.cookie, { note: 'Looks right' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id,
      status: 'approved',
      decidedBy: { userId: A.admin.userId, name: expect.any(String) },
      decisionNote: 'Looks right',
      decidedAt: expect.any(String),
    });
    const ruleId = r.body.ruleId as string;
    const { rows } = await api.pool.query(
      'SELECT name, conditions, actions, mode, enabled FROM rule WHERE id = $1 AND brand_id = $2',
      [ruleId, A.brandId],
    );
    expect(rows[0]).toMatchObject({
      name: 'giveaway',
      conditions: expect.objectContaining({ type: 'keyword', terms: ['giveaway'] }),
      actions: [{ type: 'hide' }],
      mode: 'enforce',
      enabled: true,
    });
    expect(await proposalRow(id)).toMatchObject({
      status: 'approved',
      decided_by_user_id: A.admin.userId,
      applied_rule_id: ruleId,
    });
    expect(await audits(id)).toEqual([
      expect.objectContaining({ action: 'rule_change.proposed', actor_user_id: null }),
      {
        action: 'rule_change.approved',
        actor_user_id: A.admin.userId,
        details: { proposalId: id, ruleId, operation: 'create' },
      },
    ]);
    expect(await audits(ruleId)).toEqual([
      expect.objectContaining({ action: 'rule.created', actor_user_id: A.admin.userId }),
    ]);
  });

  it('approve update applies the patch; approve archive archives', async () => {
    const ruleId = await createRule('to change');
    const up = await propose({ operation: 'update', ruleId, patch: { enabled: false } });
    const r = await approve(up);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'approved', ruleId });
    expect((await liveRules()).find((x) => x.id === ruleId)).toMatchObject({
      name: 'to change',
      enabled: false,
    });
    expect((await audits(ruleId)).map((a) => [a.action, a.actor_user_id])).toEqual([
      ['rule.created', A.owner.userId],
      ['rule.updated', A.admin.userId],
    ]);

    const arch = await propose({ operation: 'archive', ruleId });
    expect((await approve(arch)).status).toBe(200);
    expect((await liveRules()).map((x) => x.id)).not.toContain(ruleId);
    expect((await audits(ruleId)).at(-1)).toMatchObject({
      action: 'rule.archived',
      actor_user_id: A.admin.userId,
    });
  });

  it('reject → status rejected, rules unchanged, audit rule_change.rejected', async () => {
    const id = await proposeCreate('rejected one');
    const before = await liveRules();
    const r = await reject(id, A.owner.cookie, { note: 'Too broad' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', decisionNote: 'Too broad' });
    expect(await liveRules()).toEqual(before);
    expect(await proposalRow(id)).toMatchObject({
      status: 'rejected',
      decided_by_user_id: A.owner.userId,
      applied_rule_id: null,
    });
    expect((await audits(id)).at(-1)).toEqual({
      action: 'rule_change.rejected',
      actor_user_id: A.owner.userId,
      details: { proposalId: id, operation: 'create' },
    });
    expect((await reject(id)).body.error.code).toBe('proposal_not_pending');
  });

  it('approve after expiry → 409 proposal_expired, status expired, rules unchanged', async () => {
    const id = await proposeCreate('too late');
    await api.pool.query(
      `UPDATE rule_change_proposal SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    const before = await liveRules();
    const r = await approve(id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('proposal_expired');
    expect(await liveRules()).toEqual(before);
    expect(await proposalRow(id)).toMatchObject({
      status: 'expired',
      decided_by_user_id: null,
      decided_at: expect.any(Date),
    });
    expect((await audits(id)).at(-1)).toMatchObject({
      action: 'rule_change.expired',
      actor_user_id: A.admin.userId,
    });
    expect((await approve(id)).body.error.code).toBe('proposal_not_pending');
  });

  it('rule edited via dashboard after proposal → approve → 409 proposal_stale, rules unchanged', async () => {
    const id = await proposeCreate('stale one');
    await createRule('edited meanwhile');
    const shown = await api.req('GET', changes(id), { cookie: A.admin.cookie });
    expect(shown.body.isStale).toBe(true);
    const before = await liveRules();
    const r = await approve(id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('proposal_stale');
    expect(await liveRules()).toEqual(before);
    expect(await proposalRow(id)).toMatchObject({ status: 'stale', decided_by_user_id: null });
    expect((await audits(id)).at(-1)).toMatchObject({
      action: 'rule_change.stale',
      actor_user_id: A.admin.userId,
    });
  });

  it('approve twice → second 409 proposal_not_pending', async () => {
    const id = await proposeCreate('twice');
    expect((await approve(id)).status).toBe(200);
    const again = await approve(id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('proposal_not_pending');
  });

  it('member session → 403; Bearer write API key with no cookie → 401; no state change', async () => {
    const id = await proposeCreate('not yours');
    const before = await liveRules();
    expect((await approve(id, A.member.cookie)).status).toBe(403);
    expect((await reject(id, A.member.cookie)).status).toBe(403);
    for (const action of ['approve', 'reject']) {
      const r = await api.req('POST', `${changes(id)}/${action}`, {
        headers: bearer(writerA),
        body: {},
      });
      expect(r.status).toBe(401);
    }
    expect((await api.req('GET', changes(id), { headers: bearer(writerA) })).status).toBe(401);
    expect(await liveRules()).toEqual(before);
    expect(await proposalRow(id)).toMatchObject({ status: 'pending', decided_at: null });
    expect((await audits(id)).map((a) => a.action)).toEqual(['rule_change.proposed']);
  });

  it('proposal of org A via org B URL → 404', async () => {
    const id = await proposeCreate('foreign');
    const viaB = `${changes(id, B)}`;
    expect((await api.req('GET', viaB, { cookie: B.owner.cookie })).status).toBe(404);
    expect(
      (await api.req('POST', `${viaB}/approve`, { cookie: B.owner.cookie, body: {} })).status,
    ).toBe(404);
    expect(
      (await api.req('POST', `${viaB}/reject`, { cookie: B.owner.cookie, body: {} })).status,
    ).toBe(404);
    const { rows } = await api.pool.query<{ id: string }>(
      'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
      [A.orgId, `Other ${randomUUID()}`],
    );
    const otherBrand = { ...A, brandId: rows[0]!.id };
    expect((await api.req('GET', changes(id, otherBrand), { cookie: A.admin.cookie })).status).toBe(
      404,
    );
    expect(
      (
        await api.req('POST', `${changes(id, otherBrand)}/approve`, {
          cookie: A.admin.cookie,
          body: {},
        })
      ).status,
    ).toBe(404);
    expect(await proposalRow(id)).toMatchObject({ status: 'pending' });
  });

  it('two concurrent approves → exactly one 200, one 409', async () => {
    const id = await proposeCreate('raced');
    const before = (await liveRules()).length;
    const results = await Promise.all([approve(id, A.admin.cookie), approve(id, A.owner.cookie)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('proposal_not_pending');
    expect((await liveRules()).length).toBe(before + 1);
  });

  it('rejects a note over 500 characters', async () => {
    const id = await proposeCreate('long note');
    expect((await approve(id, A.admin.cookie, { note: 'x'.repeat(501) })).status).toBe(400);
    expect(await proposalRow(id)).toMatchObject({ status: 'pending' });
    await reject(id);
  });
});
