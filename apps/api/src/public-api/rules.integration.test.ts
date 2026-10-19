// GET /v1/rules and POST /v1/rule-change-proposals.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys, routeSpec } from '@feedbouncer/public-api';
import {
  orgWithRoles,
  startTestApi,
  WEB,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';

const HOUR = 3_600_000;

let api: TestApi;
let A: OrgFixture;
let B: OrgFixture;
let keys: PgApiKeys;
let reader: string;
let writer: string;
let ruleA: string;
let ruleB: string;
let ipCounter = 0;

const headers = (token: string, idem?: string) => ({
  authorization: `Bearer ${token}`,
  'x-forwarded-for': `203.0.113.${(++ipCounter % 250) + 1}`,
  ...(idem !== undefined && { 'idempotency-key': idem }),
});

async function newKey(org: OrgFixture, scope: 'read' | 'write'): Promise<string> {
  const { token } = await keys.create(org.orgId, org.owner.userId, {
    name: `k-${randomUUID()}`,
    scope,
  });
  return token.reveal();
}

async function createRule(org: OrgFixture, name: string, brandId = org.brandId): Promise<string> {
  const r = await api.req('POST', `/api/v1/orgs/${org.orgId}/brands/${brandId}/rules`, {
    cookie: org.owner.cookie,
    body: {
      name,
      conditions: { type: 'keyword', terms: [name] },
      actions: [{ type: 'flag_for_review' }],
    },
  });
  if (r.status !== 201) throw new Error(`rule create failed: ${r.status}`);
  return r.body.id as string;
}

async function newBrand(org: OrgFixture): Promise<string> {
  const { rows } = await api.pool.query<{ id: string }>(
    'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
    [org.orgId, `Brand ${randomUUID()}`],
  );
  return rows[0]!.id;
}

const listRules = (query = '', token = reader) =>
  api.req('GET', `/v1/rules${query}`, { headers: headers(token) });

const propose = (body: unknown, opts: { token?: string; idem?: string } = {}) =>
  api.req('POST', '/v1/rule-change-proposals', {
    headers: headers(opts.token ?? writer, opts.idem),
    body,
  });

const createBody = (name: string, brandId = A.brandId) => ({
  brandId,
  operation: 'create',
  rule: {
    name,
    conditions: { type: 'keyword', terms: [name] },
    actions: [{ type: 'hide' }],
    mode: 'enforce',
  },
  rationale: 'Seen a lot of these',
});

async function liveState(brandId: string) {
  const { rows } = await api.pool.query<{ n: number; rev: string }>(
    `SELECT (SELECT count(*)::int FROM rule WHERE brand_id = $1 AND archived_at IS NULL) AS n,
            (SELECT rule_revision::text FROM brand WHERE id = $1) AS rev`,
    [brandId],
  );
  return rows[0];
}

const auditCount = async (orgId: string): Promise<number> =>
  (
    await api.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1',
      [orgId],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  A = await orgWithRoles(api, 'prA');
  B = await orgWithRoles(api, 'prB');
  keys = new PgApiKeys(api.pool);
  reader = await newKey(A, 'read');
  writer = await newKey(A, 'write');
  ruleA = await createRule(A, 'alpha');
  ruleB = await createRule(B, 'beta');
});
afterAll(() => api.close());

describe('GET /v1/rules', () => {
  it('GET /v1/rules lists rules of every brand in the org; brandId filter; foreign brandId → 404; no audit row written', async () => {
    const second = await newBrand(A);
    const archived = await newBrand(A);
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [archived]);
    const before = await auditCount(A.orgId);

    const all = await listRules();
    expect(all.status).toBe(200);
    routeSpec('listRules').responses[200]!.parse(all.body);
    const ids = all.body.brands.map((b: { id: string }) => b.id);
    expect(ids.sort()).toEqual([A.brandId, second].sort());
    const brand = all.body.brands.find((b: { id: string }) => b.id === A.brandId);
    expect(brand.ruleRevision).toBe(Number((await liveState(A.brandId))!.rev));
    expect(brand.rules.map((r: { id: string }) => r.id)).toContain(ruleA);
    expect(brand.rules.find((r: { id: string }) => r.id === ruleA)).toEqual({
      id: ruleA,
      name: 'alpha',
      conditions: expect.objectContaining({ type: 'keyword', terms: ['alpha'] }),
      actions: [{ type: 'flag_for_review' }],
      mode: 'suggest',
      priority: expect.any(Number),
      enabled: true,
    });
    expect(JSON.stringify(all.body)).not.toContain(ruleB);

    const one = await listRules(`?brandId=${second}`);
    expect(one.status).toBe(200);
    expect(one.body.brands.map((b: { id: string }) => b.id)).toEqual([second]);
    expect(one.body.brands[0].rules).toEqual([]);

    expect((await listRules(`?brandId=${B.brandId}`)).status).toBe(404);
    expect((await listRules(`?brandId=${archived}`)).status).toBe(404);
    expect((await listRules('?brandId=nope')).status).toBe(400);
    expect(await auditCount(A.orgId)).toBe(before);
  });

  it('lists pending proposals as changes', async () => {
    const brandId = await newBrand(A);
    const p = await propose(createBody('listed change', brandId));
    expect(p.status).toBe(201);
    const r = await listRules(`?brandId=${brandId}`);
    expect(r.body.brands[0].changes).toEqual([
      {
        id: p.body.id,
        operation: 'create',
        ruleId: null,
        status: 'pending',
        expiresAt: p.body.expiresAt,
        decidedAt: null,
      },
    ]);
  });
});

describe('POST /v1/rule-change-proposals', () => {
  it('propose create → 201 pending, diff present, expiresAt = now + 24h (±1m), live rules unchanged (rule count and brand.rule_revision identical before/after)', async () => {
    const before = await liveState(A.brandId);
    const r = await propose(createBody('giveaway'));
    expect(r.status).toBe(201);
    routeSpec('proposeRuleChange').responses[201]!.parse(r.body);
    expect(r.body).toMatchObject({
      brandId: A.brandId,
      operation: 'create',
      ruleId: null,
      status: 'pending',
      warnings: [],
      baseRuleRevision: Number(before!.rev),
      reviewUrl: `${WEB}/orgs/${A.orgId}/brands/${A.brandId}/rules/changes/${r.body.id}`,
    });
    expect(r.body.diff).toEqual(
      expect.arrayContaining([{ field: 'name', before: null, after: 'giveaway' }]),
    );
    expect(r.body.diff).toHaveLength(5);
    expect(Math.abs(Date.parse(r.body.expiresAt) - (Date.now() + 24 * HOUR))).toBeLessThan(60_000);
    expect(await liveState(A.brandId)).toEqual(before);
  });

  it('proposes an update and an archive of an existing rule', async () => {
    const up = await propose({
      brandId: A.brandId,
      operation: 'update',
      ruleId: ruleA,
      patch: { enabled: false },
    });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ operation: 'update', ruleId: ruleA });
    expect(up.body.diff).toEqual([{ field: 'enabled', before: true, after: false }]);

    const arch = await propose({ brandId: A.brandId, operation: 'archive', ruleId: ruleA });
    expect(arch.status).toBe(201);
    expect(arch.body).toMatchObject({ operation: 'archive', ruleId: ruleA });
  });

  it('RULE_PROPOSAL_TTL_HOURS=2 → expiresAt = now + 2h', async () => {
    const short = await startTestApi({ trustProxyHops: 1, ruleProposalTtlHours: 2 });
    try {
      const org = await orgWithRoles(short, 'prTtl');
      const { token } = await new PgApiKeys(short.pool).create(org.orgId, org.owner.userId, {
        name: 'w',
        scope: 'write',
      });
      const r = await short.req('POST', '/v1/rule-change-proposals', {
        headers: headers(token.reveal()),
        body: createBody('short lived', org.brandId),
      });
      expect(r.status).toBe(201);
      expect(Math.abs(Date.parse(r.body.expiresAt) - (Date.now() + 2 * HOUR))).toBeLessThan(60_000);
    } finally {
      await short.close();
    }
  });

  it('propose overbroad regex → 422 rule_rejected reason matches_everything; no proposal row', async () => {
    const brandId = await newBrand(A);
    const r = await propose({
      brandId,
      operation: 'create',
      rule: {
        name: 'all',
        conditions: { type: 'regex', patterns: ['.*'] },
        actions: [{ type: 'hide' }],
      },
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'rule_rejected', reason: 'matches_everything' });
    const { rowCount } = await api.pool.query(
      'SELECT 1 FROM rule_change_proposal WHERE brand_id = $1',
      [brandId],
    );
    expect(rowCount).toBe(0);
  });

  it('names the existing rule a duplicate proposal repeats', async () => {
    const r = await propose({
      brandId: A.brandId,
      operation: 'create',
      rule: {
        name: 'alpha again',
        conditions: { type: 'keyword', terms: ['alpha'] },
        actions: [{ type: 'flag_for_review' }],
      },
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({
      code: 'rule_rejected',
      reason: 'duplicate_of_rule',
      ruleId: ruleA,
    });
  });

  it('propose duplicate pending → 200 same id', async () => {
    const first = await propose(createBody('twice'));
    expect(first.status).toBe(201);
    const second = await propose({ ...createBody('twice'), rationale: 'again' });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('replays the stored response for the same Idempotency-Key', async () => {
    const idem = `prop-${randomUUID()}`;
    const first = await propose(createBody('idempotent'), { idem });
    const again = await propose(createBody('idempotent'), { idem });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
  });

  it('21st pending → 409 pending_limit_reached', async () => {
    const brandId = await newBrand(A);
    const token = await newKey(A, 'write');
    for (let i = 0; i < 20; i++)
      expect((await propose(createBody(`limit ${i}`, brandId), { token })).status).toBe(201);
    const r = await propose(createBody('limit 20', brandId), { token });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('pending_limit_reached');
  });

  it('read key → 403', async () => {
    const r = await propose(createBody('read only'), { token: reader });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('insufficient_scope');
  });

  it("update a rule of another org's brand → 404", async () => {
    const own = await propose({
      brandId: A.brandId,
      operation: 'update',
      ruleId: ruleB,
      patch: { enabled: false },
    });
    expect(own.status).toBe(404);
    const foreign = await propose({
      brandId: B.brandId,
      operation: 'update',
      ruleId: ruleB,
      patch: { enabled: false },
    });
    expect(foreign.status).toBe(404);
    const archived = await newBrand(A);
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [archived]);
    expect((await propose(createBody('archived brand', archived))).status).toBe(404);
  });

  it('answers 400 for a malformed body', async () => {
    expect((await propose({ brandId: A.brandId, operation: 'rename' })).status).toBe(400);
    expect((await propose({ ...createBody('long'), rationale: 'x'.repeat(1001) })).status).toBe(
      400,
    );
  });

  it('audit rule_change.proposed has actor_type api_key', async () => {
    const r = await propose({ brandId: A.brandId, operation: 'archive', ruleId: ruleA });
    expect([200, 201]).toContain(r.status);
    const { rows } = await api.pool.query(
      `SELECT actor_type, actor_user_id, subject_type, brand_id, details FROM audit_event
        WHERE action = 'rule_change.proposed' AND subject_id = $1`,
      [r.body.id],
    );
    expect(rows).toEqual([
      {
        actor_type: 'api_key',
        actor_user_id: null,
        subject_type: 'rule_change',
        brand_id: A.brandId,
        details: expect.objectContaining({ operation: 'archive', ruleId: ruleA }),
      },
    ]);
  });
});
