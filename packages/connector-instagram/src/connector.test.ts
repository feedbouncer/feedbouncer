import { describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { createInstagramConnector } from './connector.js';
import { INSTAGRAM_REQUIRED_SCOPES, INSTAGRAM_SCOPES } from './config.js';

const connector = createInstagramConnector({
  meta: {
    appId: '1234567',
    appSecret: new Secret('s'.repeat(32)),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  },
});

describe('createInstagramConnector', () => {
  it('declares instagram capabilities and per-platform constraints', () => {
    const c = connector.capabilities;
    expect(connector.platform).toBe('instagram');
    expect(c.actions).toEqual(['hide', 'unhide', 'delete']);
    expect(c.responses).toEqual(['public_reply', 'private_reply']);
    expect(c.ingestion).toBe('webhook');
    expect(c.defaultScopes).toEqual([...INSTAGRAM_SCOPES]);
    expect(c.requiredScopes).toEqual([...INSTAGRAM_REQUIRED_SCOPES]);
    expect(c.apiHosts).toEqual(['graph.facebook.com']);
    expect(c.authorizationHosts).toEqual(['www.facebook.com']);
    expect(c.constraints).toEqual({
      privateReplyWindowMs: 7 * 86_400_000,
      privateReplyTopLevelOnly: true,
      publicReplyOnHidden: false,
      hideOwnAccountComments: false,
      maxReplyChars: { public_reply: 2200, private_reply: 1000 },
    });
  });

  it('is not refreshable', async () => {
    await expect(connector.refreshTokens!({} as never, {} as never)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'not_refreshable',
    });
  });
});
