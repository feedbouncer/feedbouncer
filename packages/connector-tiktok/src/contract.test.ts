import { beforeEach, describe, expect, it } from 'vitest';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import { createMemoryStack, type Stack } from '@feedbouncer/connectors/testing';
import { createTikTokConnector } from './connector.js';

// The generic conformance suite assumes one account per authorization, so (like Facebook)
// this connector runs its own contract over FakeTikTok: selection, rotation, hygiene.
const APP = { appId: '7300000000000001', appSecret: 'tiktok-app-SECRET-0123456789' };
const REDIRECT = 'https://app.test/api/v1/oauth/tiktok/callback';
let fake: FakeTikTok;
let stack: Stack;

beforeEach(async () => {
  fake = new FakeTikTok(APP);
  stack = await createMemoryStack(createTikTokConnector(APP), {
    webhookSecret: null,
    redirectUri: REDIRECT,
    fetch: fake.fetch,
  });
});

async function connect() {
  const { businessId, authCode } = fake.addBusinessAccount({ username: 'shop' });
  const { authorizationUrl } = await stack.oauth.start(stack.actor, 'tiktok');
  const state = new URL(authorizationUrl).searchParams.get('state')!;
  const done = await stack.oauth.complete(stack.actor, 'tiktok', { auth_code: authCode, state });
  if (!done.ok || done.kind !== 'account_selection') throw new Error('grant failed');
  const r = await stack.oauth.connectAccounts(stack.actor, 'tiktok', done.grantId, [businessId]);
  return { businessId, authCode, state, r };
}

describe('TikTok connector contract', () => {
  it('connects the authorised account and never logs a secret', async () => {
    const { businessId, authCode, state, r } = await connect();
    expect(r).toMatchObject({
      ok: true,
      results: [{ externalAccountId: businessId, status: 'connected' }],
    });
    const logs = stack.lines.join('\n');
    for (const secret of [APP.appSecret, authCode, state]) expect(logs).not.toContain(secret);
  });

  it('replaying an authorization code is refused', async () => {
    const { authCode } = await connect();
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'tiktok');
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const again = await stack.oauth.complete(stack.actor, 'tiktok', { auth_code: authCode, state });
    expect(again).toMatchObject({ ok: false, reason: 'platform_error' });
  });

  it('an authorization carried in the default `code` parameter is not accepted', async () => {
    const { authCode } = fake.addBusinessAccount();
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'tiktok');
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const done = await stack.oauth.complete(stack.actor, 'tiktok', { code: authCode, state });
    expect(done.ok).toBe(false);
  });
});
