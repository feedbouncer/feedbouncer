// Rules, own domains, rule activity and per-comment decisions over the API.
// Decisions come from the real rule_evaluate job, run inline against the API's pool
// (the worker runs it in production).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRunner, PgActionRunStore, PgReviewQueue } from '@feedbouncer/actions';
import {
  PgRuleStore,
  PgEvaluationStore,
  RuleSetCache,
  RuleStepFallback,
  bodySha256,
  ruleEvaluateJob,
} from '@feedbouncer/rules';
import type { JobContext } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const MARKER = 'zq7marker-term';

let api: TestApi;
let org: OrgFixture;
let seq = 0;

const base = (o: OrgFixture = org) => `/api/v1/orgs/${o.orgId}/brands/${o.brandId}`;
const call = (method: string, path: string, body?: unknown, cookie = org.owner.cookie, o = org) =>
  api.req(method, `${base(o)}${path}`, { cookie, ...(body !== undefined && { body }) });

const keyword = (...terms: string[]) => ({ type: 'keyword', terms });
const rule = (name: string, conditions: unknown, extra: object = {}) => ({
  name,
  conditions,
  actions: [{ type: 'flag_for_review' }],
  ...extra,
});

beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK, instagram: { meta: FACEBOOK } });
  org = await orgWithRoles(api, 'rules');
});
afterAll(() => api.close());

describe('rules', () => {
  it('creates a rule of each kind with a position and mode suggest by default', async () => {
    const conditions = [
      keyword('spam'),
      { type: 'regex', patterns: ['free\\s+money'] },
      { type: 'link_domain', mode: 'blocklist', domains: ['bad.example.com'] },
      { type: 'emoji', emoji: ['🔥'] },
      { type: 'author', list: 'block', platform: 'facebook', entries: [{ externalId: '123' }] },
      { type: 'competitor', names: ['Acme'], handles: [], domains: [] },
    ];
    const kinds: string[] = [];
    for (const [i, c] of conditions.entries()) {
      const r = await call('POST', '/rules', rule(`rule ${i}`, c));
      expect(r.status).toBe(201);
      expect(r.body.mode).toBe('suggest');
      expect(r.body.enabled).toBe(true);
      expect(r.body.position).toBe(i + 1);
      kinds.push(r.body.kind);
    }
    expect(kinds).toEqual(['keyword', 'regex', 'link_domain', 'emoji', 'author', 'competitor']);
    const list = await call('GET', '/rules');
    expect(list.body.rules.map((x: { name: string }) => x.name)).toEqual(
      conditions.map((_, i) => `rule ${i}`),
    );
  });

  it('rejects an invalid regex with the issue path and message', async () => {
    const r = await call(
      'POST',
      '/rules',
      rule('bad', { type: 'regex', patterns: ['ok', '(unclosed'] }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_rule');
    const issue = r.body.error.issues.find(
      (i: { path: string }) => i.path === 'conditions.patterns.1',
    );
    expect(issue.message).toMatch(/Invalid regular expression/);
  });

  it('rejects an invalid link domain and an allow list that hides', async () => {
    const link = await call(
      'POST',
      '/rules',
      rule('bad link', { type: 'link_domain', mode: 'blocklist', domains: ['localhost'] }),
    );
    expect(link.status).toBe(400);
    expect(link.body.error.code).toBe('invalid_rule');
    const author = await call(
      'POST',
      '/rules',
      rule(
        'bad list',
        { type: 'author', list: 'allow', platform: 'facebook', entries: [{ externalId: '1' }] },
        { actions: [{ type: 'hide' }] },
      ),
    );
    expect(author.status).toBe(400);
    expect(author.body.error.code).toBe('invalid_rule');
  });

  it('patches enabled, mode and terms; GET reflects them', async () => {
    const created = await call('POST', '/rules', rule('patch me', keyword('alpha')));
    const id = created.body.id as string;
    const r = await call('PATCH', `/rules/${id}`, {
      enabled: false,
      mode: 'enforce',
      conditions: keyword('beta', 'gamma'),
    });
    expect(r.status).toBe(200);
    const got = await call('GET', `/rules/${id}`);
    expect(got.body).toMatchObject({
      enabled: false,
      mode: 'enforce',
      conditions: { type: 'keyword', terms: ['beta', 'gamma'] },
    });
    const bad = await call('PATCH', `/rules/${id}`, { actions: 'nope' });
    expect(bad.status).toBe(400);
    const unknown = await call('PATCH', `/rules/${randomUUID()}`, { enabled: true });
    expect(unknown.status).toBe(404);
  });

  it('rejects a patch that makes the action invalid for the conditions', async () => {
    const created = await call(
      'POST',
      '/rules',
      rule(
        'allow list',
        { type: 'author', list: 'allow', platform: 'facebook', entries: [{ externalId: '1' }] },
        { actions: [] },
      ),
    );
    const r = await call('PATCH', `/rules/${created.body.id}`, {
      actions: [{ type: 'hide' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_rule');
  });

  it('reorders; a missing id is a mismatch', async () => {
    const a = (await call('POST', '/rules', rule('ord a', keyword('oa')))).body.id as string;
    const b = (await call('POST', '/rules', rule('ord b', keyword('ob')))).body.id as string;
    const all = (await call('GET', '/rules')).body.rules.map(
      (x: { id: string }) => x.id,
    ) as string[];
    const reordered = [b, a, ...all.filter((id) => id !== a && id !== b)];
    const r = await call('PUT', '/rules/order', { ruleIds: reordered });
    expect(r.status).toBe(200);
    expect(r.body.rules.map((x: { id: string }) => x.id)).toEqual(reordered);
    const miss = await call('PUT', '/rules/order', { ruleIds: reordered.slice(1) });
    expect(miss.status).toBe(409);
    expect(miss.body.error.code).toBe('rule_order_mismatch');
  });

  it('flags a rule shadowed by an earlier broader one', async () => {
    const first = await call(
      'POST',
      '/rules',
      rule('broad', keyword('crypto'), { mode: 'enforce' }),
    );
    const second = await call('POST', '/rules', rule('narrow', keyword('free crypto')));
    expect(second.body.warnings.shadowedBy).toEqual({ id: first.body.id, name: 'broad' });
    const list = await call('GET', '/rules');
    const found = list.body.rules.find((x: { id: string }) => x.id === second.body.id);
    expect(found.warnings.shadowedBy.id).toBe(first.body.id);
    expect(first.body.warnings).toEqual({ shadowedBy: null, neverMatches: false, invalid: false });
  });

  it('lets a member read but not write', async () => {
    const m = org.member.cookie;
    expect((await call('GET', '/rules', undefined, m)).status).toBe(200);
    const id = (await call('GET', '/rules')).body.rules[0].id as string;
    const writes: [string, string, unknown][] = [
      ['POST', '/rules', rule('x', keyword('x'))],
      ['PATCH', `/rules/${id}`, { enabled: false }],
      ['DELETE', `/rules/${id}`, undefined],
      ['PUT', '/rules/order', { ruleIds: [] }],
      ['POST', '/domains', { domain: 'example.org' }],
    ];
    for (const [method, path, body] of writes)
      expect((await call(method, path, body, m)).status, `${method} ${path}`).toBe(403);
  });
});

describe('own domains', () => {
  it('normalizes, rejects duplicates and invalid names, shows unicode', async () => {
    const added = await call('POST', '/domains', { domain: 'https://www.Example.com/x' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ domain: 'example.com', displayDomain: 'example.com' });
    const dup = await call('POST', '/domains', { domain: 'example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('domain_exists');
    const idn = await call('POST', '/domains', { domain: 'español.com' });
    expect(idn.status).toBe(201);
    expect(idn.body).toMatchObject({ domain: 'xn--espaol-zwa.com', displayDomain: 'español.com' });
    const bad = await call('POST', '/domains', { domain: 'localhost' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_domain');
    const list = await call('GET', '/domains', undefined, org.member.cookie);
    expect(list.body.domains.map((d: { domain: string }) => d.domain)).toEqual([
      'example.com',
      'xn--espaol-zwa.com',
    ]);
    expect((await call('DELETE', `/domains/${added.body.id}`)).status).toBe(204);
    expect((await call('DELETE', `/domains/${added.body.id}`)).status).toBe(404);
  });
});

describe('decisions', () => {
  let dec: OrgFixture;
  let fb: ConnectionScope;
  let ig: ConnectionScope;
  let keywordRuleId: string;
  let competitorRuleId: string;
  let archivedRuleId: string;

  const store = () => api.deps.comments!.store;
  async function addComment(scope: ConnectionScope, body: string): Promise<string> {
    const n = ++seq;
    const r = await store().upsertFromPlatform(
      scope,
      {
        externalId: `9_${n}_1`,
        sourceExternalId: `9_${n}`,
        parentExternalId: null,
        author: { externalId: `4${n}`, displayName: `Author ${n}`, profileUrl: null },
        body,
        postedAt: new Date(Date.now() - n * 1000),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: 'own-account', syncedAt: new Date() },
    );
    return r.commentId;
  }

  async function evaluate(scope: ConnectionScope, platform: 'facebook' | 'instagram', id: string) {
    const row = (await store().load(scope, id))!;
    const evaluations = new PgEvaluationStore(api.pool);
    const rules = new PgRuleStore(api.pool);
    const runner = new ActionRunner({
      pool: api.pool,
      runs: new PgActionRunStore(api.pool),
      review: new PgReviewQueue(api.pool),
      comments: store(),
      actions: api.deps.comments!.actions,
      connection: async (s) => {
        const caps = api.deps.connectors!.registry.get(platform)?.capabilities;
        return caps
          ? { connectionId: s.connectionId, platform, caps, grantedScopes: caps.defaultScopes }
          : null;
      },
      brandName: async () => 'Brand',
      // The worker runs the advance job; the test advances inline.
      producer: { enqueue: async () => ({ status: 'enqueued' }) as never },
      clock: { now: () => Date.now() },
      log: api.deps.log,
      observer: new RuleStepFallback({ evaluations, log: api.deps.log }),
    });
    const job = ruleEvaluateJob({
      comments: store(),
      evaluations,
      cache: new RuleSetCache(rules),
      runner,
      rules,
      log: api.deps.log,
    });
    const ctx: JobContext = {
      scope,
      platform,
      jobType: 'rule_evaluate',
      ledgerId: randomUUID(),
      attempt: 1,
      isReplay: false,
      signal: AbortSignal.timeout(30_000),
      log: api.deps.log,
    };
    const result = await job.handle(ctx, {
      commentId: id,
      bodySha256: bodySha256(row.body),
      trigger: 'ingest',
    });
    const { rows } = await api.pool.query<{ id: string }>(
      'SELECT id FROM action_run WHERE comment_id = $1 AND NOT dry_run',
      [id],
    );
    for (const r of rows) await runner.advance(scope, r.id);
    return result;
  }

  beforeAll(async () => {
    dec = await orgWithRoles(api, 'dec', org);
    fb = (await api.seedConnection(dec, { platform: 'facebook', externalAccountId: '1000000099' }))
      .scope;
    ig = (
      await api.seedConnection(dec, { platform: 'instagram', externalAccountId: '17841400000099' })
    ).scope;
    const mk = async (r: object) =>
      (await call('POST', '/rules', r, org.owner.cookie, dec)).body.id;
    keywordRuleId = await mk(rule('Spam words', keyword('buyfollowers'), { mode: 'enforce' }));
    competitorRuleId = await mk(
      rule(
        'Competitors',
        { type: 'competitor', names: ['Rivalco'], handles: [], domains: [] },
        { mode: 'enforce' },
      ),
    );
    await mk(
      rule('Delete rude', keyword(MARKER), {
        actions: [{ type: 'delete', confirmIrreversible: true }],
        mode: 'enforce',
      }),
    );
    archivedRuleId = await mk(rule('Old rule', keyword('oldterm'), { mode: 'enforce' }));
  });

  it('returns rule name, reason, outcome, mode, time and action status', async () => {
    const id = await addComment(fb, 'please buyfollowers now');
    await evaluate(fb, 'facebook', id);
    const r = await call('GET', `/comments/${id}/decisions`, undefined, org.member.cookie, dec);
    expect(r.status).toBe(200);
    expect(r.body.decisions).toHaveLength(1);
    expect(r.body.decisions[0]).toMatchObject({
      outcome: 'flag',
      mode: 'enforce',
      actorType: 'rule',
      rule: { id: keywordRuleId, name: 'Spam words', kind: 'keyword', archived: false },
      fallback: false,
      action: null,
    });
    expect(r.body.decisions[0].reason).toEqual(expect.any(String));
    expect(new Date(r.body.decisions[0].createdAt).getTime()).not.toBeNaN();
  });

  it('joins the requested platform action to an enforced decision', async () => {
    const id = await addComment(fb, `contains ${MARKER}`);
    await evaluate(fb, 'facebook', id);
    const r = await call('GET', `/comments/${id}/decisions`, undefined, org.owner.cookie, dec);
    expect(r.body.decisions).toHaveLength(1);
    expect(r.body.decisions[0]).toMatchObject({
      outcome: 'remove',
      fallback: false,
      action: { kind: 'delete', status: 'pending', outcomeCode: null },
    });
  });

  it('joins the action of the run step even when the runner suffixed its request key', async () => {
    const id = await addComment(fb, `contains ${MARKER}`);
    await evaluate(fb, 'facebook', id);
    await api.pool.query(
      `UPDATE moderation_action SET request_key = request_key || ':1' WHERE comment_id = $1`,
      [id],
    );
    const r = await call('GET', `/comments/${id}/decisions`, undefined, org.owner.cookie, dec);
    expect(r.body.decisions[0].action).toMatchObject({ kind: 'delete' });
  });

  it('marks the fallback flag when the action cannot be requested', async () => {
    await api.pool.query(`UPDATE connection SET status = 'reconnect_required' WHERE id = $1`, [
      ig.connectionId,
    ]);
    const id = await addComment(ig, `contains ${MARKER}`);
    await evaluate(ig, 'instagram', id);
    const r = await call('GET', `/comments/${id}/decisions`, undefined, org.owner.cookie, dec);
    const flag = r.body.decisions.find((d: { outcome: string }) => d.outcome === 'flag');
    expect(flag.fallback).toBe(true);
    const removed = r.body.decisions.find((d: { outcome: string }) => d.outcome === 'remove');
    expect(removed.fallback).toBe(false);
    expect(flag.rule.id).toBe(removed.rule.id);
  });

  it('is a 404 for a comment of another brand', async () => {
    const other = await addComment(fb, 'hi');
    const r = await api.req('GET', `${base(org)}/comments/${other}/decisions`, {
      cookie: org.owner.cookie,
    });
    expect(r.status).toBe(404);
  });

  it('puts latestDecision on the comments list', async () => {
    const id = await addComment(fb, 'Rivalco is better');
    const plain = await addComment(fb, 'nice post');
    await evaluate(fb, 'facebook', id);
    const r = await call('GET', '/comments', undefined, org.owner.cookie, dec);
    const byId = new Map(r.body.comments.map((c: { id: string }) => [c.id, c]));
    expect(byId.get(id)).toMatchObject({
      latestDecision: { outcome: 'flag', rule: { id: competitorRuleId } },
    });
    expect(byId.get(plain)).toMatchObject({ latestDecision: null });
  });

  it('shows archived rules by name in decisions after DELETE', async () => {
    const id = await addComment(fb, 'this has oldterm in it');
    await evaluate(fb, 'facebook', id);
    expect(
      (await call('DELETE', `/rules/${archivedRuleId}`, undefined, org.owner.cookie, dec)).status,
    ).toBe(204);
    const ruleList = await call('GET', '/rules', undefined, org.owner.cookie, dec);
    expect(ruleList.body.rules.map((x: { id: string }) => x.id)).not.toContain(archivedRuleId);
    const r = await call('GET', `/comments/${id}/decisions`, undefined, org.owner.cookie, dec);
    expect(r.body.decisions[0].rule).toMatchObject({
      id: archivedRuleId,
      name: 'Old rule',
      archived: true,
    });
    expect(
      (await call('GET', `/rules/${archivedRuleId}`, undefined, org.owner.cookie, dec)).status,
    ).toBe(404);
  });

  it('lists activity filtered by kind, paginated, with a short excerpt', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await addComment(fb, `Rivalco ${'x'.repeat(300)} ${i}`);
      await evaluate(fb, 'facebook', id);
    }
    const all = await call('GET', '/rule-activity?limit=100', undefined, org.member.cookie, dec);
    expect(all.status).toBe(200);
    const kinds = new Set(all.body.items.map((i: { rule: { kind: string } }) => i.rule.kind));
    expect(kinds.size).toBeGreaterThan(1);

    const page1 = await call(
      'GET',
      '/rule-activity?kind=competitor&limit=2',
      undefined,
      org.owner.cookie,
      dec,
    );
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    for (const item of page1.body.items) {
      expect(item.rule.kind).toBe('competitor');
      expect(item.commentExcerpt.length).toBeLessThanOrEqual(140);
      expect(item).toMatchObject({ commentId: expect.any(String), platform: 'facebook' });
    }
    const page2 = await call(
      'GET',
      `/rule-activity?kind=competitor&limit=2&before=${page1.body.nextCursor}`,
      undefined,
      org.owner.cookie,
      dec,
    );
    const ids1 = page1.body.items.map((i: { id: string }) => i.id);
    expect(page2.body.items.length).toBeGreaterThan(0);
    for (const item of page2.body.items) {
      expect(item.rule.kind).toBe('competitor');
      expect(ids1).not.toContain(item.id);
    }
    const bad = await call('GET', '/rule-activity?before=nope', undefined, org.owner.cookie, dec);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
  });
});

describe('audit', () => {
  it('records rule and domain changes without terms or patterns', async () => {
    const ao = await orgWithRoles(api, 'audit', org);
    const c = (m: string, p: string, b?: unknown) => call(m, p, b, org.owner.cookie, ao);
    const created = await c('POST', '/rules', rule('audited', keyword(MARKER)));
    const id = created.body.id as string;
    await c('PATCH', `/rules/${id}`, { conditions: keyword(`${MARKER}-2`), enabled: false });
    await c('PUT', '/rules/order', { ruleIds: [id] });
    const dom = await c('POST', '/domains', { domain: 'audit-own.example.com' });
    await c('DELETE', `/domains/${dom.body.id}`);
    await c('DELETE', `/rules/${id}`);
    const { rows } = await api.pool.query<{
      action: string;
      subject_type: string;
      details: unknown;
    }>(
      `SELECT action, subject_type, details FROM audit_event
        WHERE organization_id = $1 AND action ~ '^(rule|brand_domain)\\.' ORDER BY sequence`,
      [ao.orgId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'rule.created',
      'rule.updated',
      'rule.reordered',
      'brand_domain.added',
      'brand_domain.removed',
      'rule.archived',
    ]);
    expect(rows.map((r) => r.subject_type)).toEqual([
      'rule',
      'rule',
      'rule',
      'brand_domain',
      'brand_domain',
      'rule',
    ]);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  });
});
