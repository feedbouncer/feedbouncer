// Onboarding step 2: GET/PUT /defaults.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';
import { defaultsFingerprint } from './onboarding.service.js';

let api: TestApi;
let aiApi: TestApi;
let users: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
let seq = 0;

beforeAll(async () => {
  api = await startTestApi();
  aiApi = await startTestApi({ classifier: { id: 'fake', model: 'fake-1', enabled: true } });
  const first = await orgWithRoles(api, 'onbd');
  users = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(async () => {
  await aiApi.close();
  await api.close();
});

const fresh = () => orgWithRoles(api, `onbd${++seq}`, users);
const url = (f: { orgId: string }, p = '') => `/api/v1/orgs/${f.orgId}/onboarding${p}`;
const call = (method: string, path: string, user: TestUser, body?: unknown, t: TestApi = api) =>
  t.req(method, path, { cookie: user.cookie, ...(body !== undefined && { body }) });

/** A fresh org whose connect step is done. */
async function connected() {
  const f = await fresh();
  await api.seedConnection(f, { platform: 'facebook', externalAccountId: `d${seq}` });
  await call('POST', url(f, '/start'), f.owner, {});
  const r = await call('POST', url(f, '/connect/complete'), f.owner, {});
  expect(r.status).toBe(200);
  return f;
}

const CATS = [
  'spam',
  'scam_phishing',
  'harassment_abuse',
  'hate_speech',
  'sexual_content',
  'profanity',
  'self_promotion',
] as const;
const choicesFrom = (
  cats: { category: string; action: string }[],
  over: Record<string, string> = {},
) => cats.map((c) => ({ category: c.category, action: over[c.category] ?? c.action }));
const thresholdRows = async (orgId: string) =>
  (
    await api.pool.query(
      'SELECT category, threshold::float AS threshold, action FROM classifier_threshold WHERE organization_id = $1',
      [orgId],
    )
  ).rows;
const audits = async (orgId: string, action: string) =>
  Number(
    (
      await api.pool.query(
        'SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1 AND action = $2',
        [orgId, action],
      )
    ).rows[0].n,
  );

describe('fingerprint', () => {
  it('is the sha256 of rows sorted by category as category:action:threshold', () => {
    const rows = [
      { category: 'spam', action: 'flag', threshold: 0.8 },
      { category: 'hate_speech', action: 'hide', threshold: 0.5 },
    ];
    const want = createHash('sha256').update('hate_speech:hide:0.5,spam:flag:0.8').digest('hex');
    expect(defaultsFingerprint(rows)).toBe(want);
    expect(defaultsFingerprint([...rows].reverse())).toBe(want);
  });
});

describe('GET /defaults', () => {
  it('fresh brand: scam_phishing and hate_speech = hide, the other five = flag, all default', async () => {
    const f = await connected();
    const r = await call('GET', url(f, '/defaults'), f.owner);
    expect(r.status).toBe(200);
    expect(r.body.categories).toHaveLength(7);
    for (const c of r.body.categories) {
      expect(c.source).toBe('default');
      expect(c.action).toBe(
        ['scam_phishing', 'hate_speech'].includes(c.category) ? 'hide' : 'flag',
      );
    }
    expect(r.body.categories.map((c: { category: string }) => c.category).sort()).toEqual(
      [...CATS].sort(),
    );
    expect(r.body.basedOn).toBe(defaultsFingerprint(r.body.categories));
    expect(r.body.aiEnabled).toBe(false);
  });

  it('aiEnabled is true when the classifier provider is enabled', async () => {
    const f = await orgWithRoles(aiApi, `onbdai${++seq}`);
    const r = await call('GET', url(f, '/defaults'), f.owner, undefined, aiApi);
    expect(r.status).toBe(200);
    expect(r.body.aiEnabled).toBe(true);
  });

  it('needs org.update', async () => {
    const f = await connected();
    expect((await call('GET', url(f, '/defaults'), f.member)).status).toBe(403);
  });
});

describe('PUT /defaults', () => {
  it('unchanged choices: step done, zero classifier_threshold rows, one defaults_saved audit', async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const r = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories),
      basedOn: g.basedOn,
    });
    expect(r.status).toBe(200);
    expect(r.body.steps.defaults).toBe('done');
    expect(await thresholdRows(f.orgId)).toEqual([]);
    expect(await audits(f.orgId, 'classifier_threshold.updated')).toBe(0);
    expect(await audits(f.orgId, 'onboarding.defaults_saved')).toBe(1);
  });

  it('a repeated identical PUT on a done step writes no extra audit row', async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const body = { choices: choicesFrom(g.categories), basedOn: g.basedOn };
    expect((await call('PUT', url(f, '/defaults'), f.owner, body)).status).toBe(200);
    const again = await call('PUT', url(f, '/defaults'), f.owner, body);
    expect(again.status).toBe(200);
    expect(again.body.steps.defaults).toBe('done');
    expect(await audits(f.orgId, 'onboarding.defaults_saved')).toBe(1);
  });

  it('spam=hide writes exactly one row keeping threshold 0.8', async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const r = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories, { spam: 'hide' }),
      basedOn: g.basedOn,
    });
    expect(r.status).toBe(200);
    expect(await thresholdRows(f.orgId)).toEqual([
      { category: 'spam', threshold: 0.8, action: 'hide' },
    ]);
    expect(await audits(f.orgId, 'classifier_threshold.updated')).toBe(1);
    const d = await api.pool.query(
      `SELECT details FROM audit_event WHERE organization_id = $1 AND action = 'onboarding.defaults_saved'`,
      [f.orgId],
    );
    expect(d.rows[0].details).toMatchObject({ changed: 'spam' });
  });

  it('stale basedOn: 409 onboarding_defaults_stale with current categories, no write', async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.admin)).body;
    const b = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories, { spam: 'hide' }),
      basedOn: g.basedOn,
    });
    expect(b.status).toBe(200);
    const a = await call('PUT', url(f, '/defaults'), f.admin, {
      choices: choicesFrom(g.categories, { profanity: 'approve' }),
      basedOn: g.basedOn,
    });
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('onboarding_defaults_stale');
    const spam = a.body.error.categories.find((c: { category: string }) => c.category === 'spam');
    expect(spam).toMatchObject({ action: 'hide', threshold: 0.8 });
    expect(await thresholdRows(f.orgId)).toHaveLength(1);
  });

  it('before connect is done: 409 onboarding_step_locked', async () => {
    const f = await fresh();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const r = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories),
      basedOn: g.basedOn,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('onboarding_step_locked');
  });

  it("action 'remove': 400", async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const r = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories, { spam: 'remove' }),
      basedOn: g.basedOn,
    });
    expect(r.status).toBe(400);
    expect(await thresholdRows(f.orgId)).toEqual([]);
  });

  it('6 categories: 400; bad basedOn: 400', async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const six = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories).slice(1),
      basedOn: g.basedOn,
    });
    expect(six.status).toBe(400);
    const bad = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories),
      basedOn: 'xyz',
    });
    expect(bad.status).toBe(400);
  });

  it('existing remove for profanity: GET shows it; PUT without profanity keeps it', async () => {
    const f = await connected();
    await api.pool.query(
      `INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action)
       VALUES ($1, $2, 'profanity', 0.7, 'remove')`,
      [f.orgId, f.brandId],
    );
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    expect(
      g.categories.find((c: { category: string }) => c.category === 'profanity'),
    ).toMatchObject({
      action: 'remove',
      source: 'brand',
    });
    const rest = choicesFrom(g.categories, { spam: 'hide' }).filter(
      (c) => c.category !== 'profanity',
    );
    const withIt = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: [...rest, { category: 'profanity', action: 'flag' }],
      basedOn: g.basedOn,
    });
    expect(withIt.status).toBe(400);
    const r = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: rest,
      basedOn: g.basedOn,
    });
    expect(r.status).toBe(200);
    const rows = await thresholdRows(f.orgId);
    expect(rows.find((x) => x.category === 'profanity')).toMatchObject({
      action: 'remove',
      threshold: 0.7,
    });
  });

  it('PUT succeeds when the classifier provider is disabled', async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    expect(g.aiEnabled).toBe(false);
    const r = await call('PUT', url(f, '/defaults'), f.owner, {
      choices: choicesFrom(g.categories, { self_promotion: 'approve' }),
      basedOn: g.basedOn,
    });
    expect(r.status).toBe(200);
  });

  it('a member cannot write', async () => {
    const f = await connected();
    const g = (await call('GET', url(f, '/defaults'), f.owner)).body;
    const r = await call('PUT', url(f, '/defaults'), f.member, {
      choices: choicesFrom(g.categories),
      basedOn: g.basedOn,
    });
    expect(r.status).toBe(403);
  });
});
