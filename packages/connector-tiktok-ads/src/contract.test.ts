import { Secret } from '@feedbouncer/service-runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import { createMemoryStack, type Stack } from '@feedbouncer/connectors/testing';
import { createTikTokAdsConnector } from './connector.js';
import { APP } from './test-world.js';

// The generic conformance suite assumes one account per authorization, so this connector runs
// its own contract over FakeTikTok: selection with several advertisers, replay, secret hygiene.
const REDIRECT = 'https://app.test/api/v1/oauth/tiktok_ads/callback';
let fake: FakeTikTok;
let stack: Stack;

beforeEach(async () => {
  fake = new FakeTikTok(APP);
  stack = await createMemoryStack(
    createTikTokAdsConnector({ ...APP, appSecret: new Secret(APP.appSecret) }),
    {
      webhookSecret: null,
      redirectUri: REDIRECT,
      fetch: fake.fetch,
    },
  );
});

async function start() {
  const { authorizationUrl } = await stack.oauth.start(stack.actor, 'tiktok_ads');
  return new URL(authorizationUrl).searchParams.get('state')!;
}

describe('TikTok ads connector contract', () => {
  it('connects the authorised advertiser and never logs a secret', async () => {
    const { advertiserId, authCode } = fake.addAdvertiser({ name: 'Acme' });
    const state = await start();
    const done = await stack.oauth.complete(stack.actor, 'tiktok_ads', {
      auth_code: authCode,
      state,
    });
    if (!done.ok || done.kind !== 'account_selection') throw new Error('grant failed');
    const r = await stack.oauth.connectAccounts(stack.actor, 'tiktok_ads', done.grantId, [
      advertiserId,
    ]);
    expect(r).toMatchObject({
      ok: true,
      results: [{ externalAccountId: advertiserId, status: 'connected' }],
    });
    const logs = stack.lines.join('\n');
    for (const secret of [APP.appSecret, authCode, state]) expect(logs).not.toContain(secret);
  });

  it('replaying an authorization code is refused', async () => {
    const { authCode } = fake.addAdvertiser();
    await stack.oauth.complete(stack.actor, 'tiktok_ads', {
      auth_code: authCode,
      state: await start(),
    });
    const again = await stack.oauth.complete(stack.actor, 'tiktok_ads', {
      auth_code: authCode,
      state: await start(),
    });
    expect(again).toMatchObject({ ok: false, reason: 'platform_error' });
  });

  it('an authorization carried in the default `code` parameter is not accepted', async () => {
    const { authCode } = fake.addAdvertiser();
    const done = await stack.oauth.complete(stack.actor, 'tiktok_ads', {
      code: authCode,
      state: await start(),
    });
    expect(done.ok).toBe(false);
  });
});
