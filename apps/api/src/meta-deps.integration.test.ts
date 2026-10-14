// The API only enqueues jobs the worker executes; each spec must be registered
// here too or the producer refuses it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from './testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

let api: TestApi;
let org: OrgFixture;

beforeAll(async () => {
  api = await startTestApi({
    facebook: FACEBOOK,
    instagram: { meta: FACEBOOK },
    metaAds: { meta: FACEBOOK, activeStatuses: ['ACTIVE'] },
  });
  org = await orgWithRoles(api, 'mdp');
});
afterAll(() => api.close());

describe('buildMetaDeps job registry', () => {
  it('can enqueue connection_backfill for facebook and instagram only', async () => {
    const producer = api.deps.producer!;
    const payload = { runId: randomUUID(), segment: 0 };
    for (const platform of ['facebook', 'instagram'] as const) {
      const { scope } = await api.seedConnection(org, { platform, externalAccountId: `ext-${platform}` });
      const r = await producer.enqueue({ scope, platform, type: 'connection_backfill', payload });
      expect(r.status).toBe('enqueued');
    }
    const { scope } = await api.seedConnection(org, { platform: 'meta_ads', externalAccountId: 'act_1' });
    await expect(
      producer.enqueue({ scope, platform: 'meta_ads', type: 'connection_backfill', payload }),
    ).rejects.toMatchObject({ code: 'unknown_job_type' });
  });
});
