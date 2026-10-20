// POST /v1/moderation/check, answered by an in-process moderation-check worker
// with fake AI providers. No organization here has a platform connection.
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError, type PreparedInput } from '@feedbouncer/ai';
import {
  DisabledProvider,
  PgThresholdStore,
  ZERO_SCORES,
  type ClassifierProvider,
  type RawClassification,
} from '@feedbouncer/classifier';
import {
  MODERATION_CHECK_QUEUE,
  startModerationCheckWorker,
  type CheckDeps,
} from '@feedbouncer/moderation-check';
import { DisabledPolicyEvaluator, PgPolicyStore } from '@feedbouncer/policies';
import { ModerationCheckResult, PgApiKeys, type ApiKeyScope } from '@feedbouncer/public-api';
import { PgRuleStore, RuleSetCache } from '@feedbouncer/rules';
import { createLogger } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const MARKER = 'zq5-check-marker';
const REF = 'order-42';
const PATH = '/v1/moderation/check';
const TABLES = [
  'comment',
  'rule_evaluation',
  'comment_classification',
  'policy_evaluation',
  'moderation_action',
  'decision',
  'job_ledger',
  'review_item',
  'webhook_delivery',
] as const;

class FakeClassifier implements ClassifierProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  readonly inputs: PreparedInput[] = [];
  next: (input: PreparedInput) => Promise<RawClassification> = async () => ({
    scores: ZERO_SCORES,
    language: 'en',
  });
  classify(input: PreparedInput): Promise<RawClassification> {
    this.inputs.push(input);
    return this.next(input);
  }
}

const workerLines: string[] = [];
const workerLog = createLogger('worker-test', 'debug', (l) => workerLines.push(l));
const workerConnections: Redis[] = [];

function startWorker(api: TestApi, deps: CheckDeps, now?: () => number) {
  const connection = new Redis(api.deps.env.redisUrl.href, { maxRetriesPerRequest: null });
  workerConnections.push(connection);
  return startModerationCheckWorker({
    connection,
    prefix: api.deps.env.jobs.prefix,
    concurrency: 2,
    pool: api.pool,
    deps,
    log: workerLog,
    ...(now && { now }),
  });
}

function checkDeps(api: TestApi, classifier: ClassifierProvider): CheckDeps {
  return {
    rules: new RuleSetCache(new PgRuleStore(api.pool)),
    thresholds: new PgThresholdStore(api.pool),
    policies: new PgPolicyStore(api.pool),
    classifier,
    policyEvaluator: new DisabledPolicyEvaluator(),
    languages: ['en'],
    classifierTimeoutMs: 2000,
    policyTimeoutMs: 2000,
  };
}

let ipCounter = 0;
const ip = () => `203.0.113.${(++ipCounter % 250) + 1}`;

async function newKey(api: TestApi, org: OrgFixture, scope: ApiKeyScope) {
  const keys = new PgApiKeys(api.pool);
  const { key, token } = await keys.create(org.orgId, org.owner.userId, {
    name: `k-${randomUUID()}`,
    scope,
  });
  return { id: key.id, token: token.reveal() };
}

const check = (api: TestApi, token: string | null, body: unknown) =>
  api.req('POST', PATH, {
    body,
    headers: {
      'x-forwarded-for': ip(),
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
  });

const injectBytes = (api: TestApi, token: string, payload: Buffer | string) =>
  api.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: PATH,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': ip(),
      },
      payload,
    });

async function counts(api: TestApi) {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    out[t] = (await api.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n;
  }
  return out;
}

async function addBrand(api: TestApi, orgId: string, archived = false): Promise<string> {
  const { rows } = await api.pool.query<{ id: string }>(
    `INSERT INTO brand (organization_id, name, archived_at)
     VALUES ($1, $2, ${archived ? 'now()' : 'NULL'}) RETURNING id`,
    [orgId, `Brand ${randomUUID()}`],
  );
  return rows[0]!.id;
}

async function enforceRule(api: TestApi, org: OrgFixture, term: string) {
  const r = await api.req('POST', `/api/v1/orgs/${org.orgId}/brands/${org.brandId}/rules`, {
    cookie: org.owner.cookie,
    body: {
      name: `Rule ${term}`,
      conditions: { type: 'keyword', terms: [term] },
      actions: [{ type: 'hide' }],
      mode: 'enforce',
    },
  });
  if (r.status !== 201) throw new Error(`rule create failed: ${r.status}`);
}

describe('POST /v1/moderation/check', () => {
  const classifier = new FakeClassifier();
  let api: TestApi;
  let org: OrgFixture;
  let deps: CheckDeps;
  let worker: { close(): Promise<void> };
  let moderate: string;
  let before: Record<string, string>;

  beforeAll(async () => {
    api = await startTestApi({
      trustProxyHops: 1,
      publicApiRateLimitPerMinute: 1000,
      moderationCheckTimeoutMs: 5000,
    });
    org = await orgWithRoles(api, 'mcheck');
    deps = checkDeps(api, classifier);
    worker = startWorker(api, deps);
    moderate = (await newKey(api, org, 'moderate')).token;
    before = await counts(api);
  });
  afterAll(async () => {
    await worker.close();
    await api.close();
  });

  const ok = async (body: unknown, token = moderate) => {
    const r = await check(api, token, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  describe('verdicts', () => {
    it('allows text nothing matches', async () => {
      const body = await ok({ text: 'hello there', brandId: org.brandId });
      expect(body).toMatchObject({
        verdict: 'allow',
        reasonCode: 'no_match',
        decidedBy: 'none',
        degraded: false,
        ref: null,
        brandId: org.brandId,
      });
      expect(ModerationCheckResult.safeParse(body).success).toBe(true);
    });

    it('blocks on an enforced rule', async () => {
      await enforceRule(api, org, 'scam');
      const body = await ok({ text: `this is a scam ${MARKER}`, brandId: org.brandId });
      expect(body).toMatchObject({ verdict: 'block', reasonCode: 'rule_matched' });
      expect(body.evidence.ruleName).toBe('Rule scam');
    });

    it('holds for review when the classifier flags', async () => {
      classifier.next = async () => ({ scores: { ...ZERO_SCORES, spam: 0.99 }, language: 'en' });
      try {
        const body = await ok({ text: `cheap pills ${MARKER}`, brandId: org.brandId });
        expect(body).toMatchObject({ verdict: 'review', reasonCode: 'classifier_threshold' });
      } finally {
        classifier.next = async () => ({ scores: ZERO_SCORES, language: 'en' });
      }
    });

    it('echoes ref back', async () => {
      const body = await ok({ text: `with a ref ${MARKER}`, ref: REF });
      expect(body.ref).toBe(REF);
    });
  });

  describe('classifier failure', () => {
    it('holds for review, degraded, when the classifier is unavailable', async () => {
      classifier.next = () => Promise.reject(new ProviderError('unavailable', true));
      try {
        const body = await ok({ text: `fine text ${MARKER}` });
        expect(body).toMatchObject({
          verdict: 'review',
          reasonCode: 'classifier_unavailable',
          degraded: true,
        });
      } finally {
        classifier.next = async () => ({ scores: ZERO_SCORES, language: 'en' });
      }
    });

    it('reports classifier_not_configured when no classifier is configured', async () => {
      deps.classifier = new DisabledProvider();
      try {
        const body = await ok({ text: `fine text ${MARKER}` });
        expect(body).toMatchObject({
          verdict: 'review',
          reasonCode: 'classifier_not_configured',
          degraded: true,
        });
      } finally {
        deps.classifier = classifier;
      }
    });
  });

  describe('authentication and scope', () => {
    it('answers identical 401 bodies for a missing, garbage or revoked key', async () => {
      const revoked = await newKey(api, org, 'moderate');
      await new PgApiKeys(api.pool).revoke(org.orgId, org.owner.userId, revoked.id);
      const body = { text: `secret ${MARKER}`, brandId: org.brandId };
      const responses = [
        await check(api, null, body),
        await check(api, 'fbk_garbage', body),
        await check(api, revoked.token, body),
      ];
      for (const r of responses) {
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('unauthenticated');
        const text = JSON.stringify(r.body);
        expect(text).not.toContain(org.brandId);
        expect(text).not.toContain('Rule scam');
        expect(text).not.toContain(MARKER);
      }
      expect(responses[1]!.body).toEqual(responses[0]!.body);
      expect(responses[2]!.body).toEqual(responses[0]!.body);
    });

    it('accepts read and write keys', async () => {
      for (const scope of ['read', 'write'] as const) {
        const { token } = await newKey(api, org, scope);
        await ok({ text: 'hello there' }, token);
      }
    });

    it('refuses a moderate key on other routes', async () => {
      const r = await api.req('GET', '/v1/comments', {
        headers: { authorization: `Bearer ${moderate}`, 'x-forwarded-for': ip() },
      });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('insufficient_scope');
    });
  });

  describe('tenancy', () => {
    it("answers 404 for another organization's brand and for an archived brand", async () => {
      const other = await orgWithRoles(api, 'mcheck-other', org);
      const archived = await addBrand(api, org.orgId, true);
      for (const brandId of [other.brandId, archived, randomUUID()]) {
        const r = await check(api, moderate, { text: 'hello there', brandId });
        expect(r.status).toBe(404);
        expect(r.body.error.code).toBe('not_found');
      }
    });

    it('requires brandId unless the organization has exactly one active brand', async () => {
      const two = await orgWithRoles(api, 'mcheck-two', org);
      await addBrand(api, two.orgId);
      const { token } = await newKey(api, two, 'moderate');
      const r = await check(api, token, { text: 'hello there' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({
        code: 'invalid_request',
        field: 'brandId',
        problem: 'required',
        message: 'brandId is required when the workspace has more or fewer than one active brand.',
      });
      const one = await ok({ text: 'hello there' });
      expect(one.brandId).toBe(org.brandId);
    });
  });

  describe('validation', () => {
    const rejects = async (body: unknown, status = 400) => {
      const r = await check(api, moderate, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      return r.body.error;
    };

    it('rejects a non-string, missing text and unknown keys', async () => {
      for (const body of [{ text: 42 }, {}, { text: 'hi', extra: 1 }, { text: 'hi', ref: 'a b' }]) {
        expect((await rejects(body)).code).toBe('invalid_request');
      }
    });

    it('rejects malformed JSON with 400, not 500', async () => {
      const r = await injectBytes(api, moderate, '{"text":');
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('invalid_request');
    });

    it('rejects text that is empty once invisible characters are removed', async () => {
      for (const text of ['   ', '​‏⁦ ']) {
        expect(await rejects({ text })).toMatchObject({
          code: 'invalid_request',
          field: 'text',
          problem: 'empty',
        });
      }
    });

    it('rejects a lone surrogate and U+0000 without running the classifier', async () => {
      const calls = classifier.inputs.length;
      for (const text of ['\ud800', 'a\u0000b']) {
        expect(await rejects({ text })).toMatchObject({
          code: 'invalid_request',
          field: 'text',
          problem: 'malformed',
        });
      }
      expect(classifier.inputs.length).toBe(calls);
    });

    it('rejects bytes that are not valid UTF-8', async () => {
      const r = await injectBytes(
        api,
        moderate,
        Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('invalid_request');
    });

    it('accepts exactly 4,000 UTF-16 units untruncated and rejects one more', async () => {
      const text = '😀'.repeat(2000);
      await ok({ text });
      const input = classifier.inputs.at(-1)!;
      expect(input.truncated).toBe(false);
      expect(input.text).toBe(text);
      expect(await rejects({ text: `${text}a` }, 422)).toMatchObject({
        code: 'text_too_long',
        maxLength: 4000,
        message: 'Text exceeds 4,000 characters (UTF-16 code units).',
      });
    });

    it('answers 413 for a body over 64 KiB', async () => {
      expect((await check(api, moderate, { text: 'a'.repeat(70_000) })).status).toBe(413);
    });
  });

  describe('behaviour', () => {
    it('applies a rule change without a restart', async () => {
      expect((await ok({ text: 'buy now', brandId: org.brandId })).verdict).toBe('allow');
      await enforceRule(api, org, 'buy now');
      expect((await ok({ text: 'buy now', brandId: org.brandId })).verdict).toBe('block');
    });

    it('gives the same answer to the same request', async () => {
      const req = { text: `same every time ${MARKER}`, brandId: org.brandId, ref: REF };
      const bodies = [];
      for (let i = 0; i < 3; i++) {
        const { checkedAt, ...rest } = await ok(req);
        expect(Number.isNaN(Date.parse(checkedAt))).toBe(false);
        bodies.push(rest);
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    });

    it('never logs the text or the ref', () => {
      const all = [...api.logLines, ...workerLines].join('\n');
      expect(workerLines.some((l) => l.includes('moderation_check.done'))).toBe(true);
      expect(all).not.toContain(MARKER);
      expect(all).not.toContain(REF);
    });

    it('writes nothing to Postgres', async () => {
      expect(await counts(api)).toEqual(before);
      const deliveries = await api.pool.query('SELECT 1 FROM webhook_delivery');
      expect(deliveries.rowCount).toBe(0);
    });
  });
});

describe('POST /v1/moderation/check without a worker', () => {
  let api: TestApi;
  let org: OrgFixture;
  let redis: Redis;
  let queue: Queue;
  const late = new FakeClassifier();

  beforeAll(async () => {
    api = await startTestApi({
      trustProxyHops: 1,
      publicApiRateLimitPerMinute: 3,
      moderationCheckTimeoutMs: 2000,
    });
    org = await orgWithRoles(api, 'mcheck-down');
    redis = new Redis(api.deps.env.redisUrl.href);
    queue = new Queue(MODERATION_CHECK_QUEUE, {
      connection: redis,
      prefix: api.deps.env.jobs.prefix,
    });
  });
  afterAll(async () => {
    await queue.close();
    redis.disconnect();
    for (const c of workerConnections) c.disconnect();
    await api.close();
  });

  const nothingLeft = async () => {
    expect(await queue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed')).toEqual({
      wait: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
    const jobKeys = (
      await redis.keys(`${api.deps.env.jobs.prefix}:${MODERATION_CHECK_QUEUE}:*`)
    ).filter((k) => /[0-9a-f]{8}-[0-9a-f]{4}-/.test(k));
    expect(jobKeys).toEqual([]);
  };

  it('answers 503 with Retry-After within the deadline and leaves no job behind', async () => {
    const { token } = await newKey(api, org, 'moderate');
    const started = Date.now();
    const r = await check(api, token, { text: `nobody home ${MARKER}`, ref: REF });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('temporarily_unavailable');
    expect(r.headers['retry-after']).toBe('5');
    await nothingLeft();

    const worker = startWorker(api, checkDeps(api, late));
    await new Promise((res) => setTimeout(res, 500));
    await worker.close();
    expect(late.inputs).toHaveLength(0);
    expect(api.logLines.join('\n')).not.toContain(MARKER);
    expect(api.logLines.join('\n')).not.toContain(REF);
  });

  it('answers 503 when the worker reports the job expired', async () => {
    const { token } = await newKey(api, org, 'moderate');
    const worker = startWorker(api, checkDeps(api, late), () => Date.now() + 60_000);
    try {
      const started = Date.now();
      const r = await check(api, token, { text: 'too late' });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(r.status).toBe(503);
      expect(r.headers['retry-after']).toBe('5');
    } finally {
      await worker.close();
    }
    expect(late.inputs).toHaveLength(0);
    await nothingLeft();
  });

  it('rate limits per key with 429 and Retry-After', async () => {
    const { token } = await newKey(api, org, 'moderate');
    for (let i = 0; i < 3; i++) expect((await check(api, token, {})).status).toBe(400);
    const r = await check(api, token, {});
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
