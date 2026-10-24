import { beforeEach, describe, expect, it } from 'vitest';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import { createMemoryStack } from '@feedbouncer/connectors/testing';
import type { Stack } from '@feedbouncer/connectors/testing';
import { createTikTokConnector } from './connector.js';

const APP = { appId: '7300000000000001', appSecret: 'tiktok-app-SECRET-0123456789' };
const REDIRECT = 'https://app.test/api/v1/oauth/tiktok/callback';
let fake: FakeTikTok;
let stack: Stack;

async function grant(authCode: string, fetch: typeof globalThis.fetch = fake.fetch) {
  stack = await createMemoryStack(createTikTokConnector(APP), {
    webhookSecret: null,
    redirectUri: REDIRECT,
    fetch,
  });
  const { authorizationUrl } = await stack.oauth.start(stack.actor, 'tiktok');
  const state = new URL(authorizationUrl).searchParams.get('state')!;
  const done = await stack.oauth.complete(stack.actor, 'tiktok', { auth_code: authCode, state });
  if (!done.ok || done.kind !== 'account_selection') throw new Error('grant failed');
  return done.grantId;
}

beforeEach(() => {
  fake = new FakeTikTok(APP);
});

describe('listAccounts', () => {
  it('lists exactly the authorised business account with a sanitised display name', async () => {
    const { businessId, authCode } = fake.addBusinessAccount({ username: 'sh\u0000op' });
    fake.addBusinessAccount();
    const grantId = await grant(authCode);
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'tiktok', grantId);
    expect(listed).toMatchObject({
      ok: true,
      accounts: [{ externalAccountId: businessId, displayName: 'sh�op', eligible: true }],
    });
    expect(listed.ok && listed.accounts).toHaveLength(1);
  });

  it('a malformed open_id is invalid_connector_output', async () => {
    const { authCode } = fake.addBusinessAccount();
    const tampering: typeof globalThis.fetch = async (input, init) => {
      const res = await fake.fetch(input, init);
      if (!String(input).includes('/business/get/')) return res;
      const json = (await res.json()) as { data: Record<string, unknown> };
      return Response.json({ ...json, data: { ...json.data, business_id: 'bad/id' } });
    };
    const grantId = await grant(authCode, tampering);
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'tiktok', grantId);
    expect(listed.ok).toBe(false);
    expect(stack.lines.join('\n')).toContain('invalid_connector_output');
  });
});
