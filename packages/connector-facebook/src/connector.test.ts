import { describe, expect, it } from 'vitest';
import { validateConnector } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FACEBOOK_SCOPES } from './config.js';
import { createFacebookConnector } from './connector.js';

describe('createFacebookConnector', () => {
  const c = createFacebookConnector({
    appId: '111',
    appSecret: new Secret('s'.repeat(32)),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  });
  it('passes framework validation', () => expect(() => validateConnector(c)).not.toThrow());
  it('declares the expected capabilities', () => {
    expect(c.platform).toBe('facebook');
    expect(c.capabilities).toMatchObject({
      actions: ['hide', 'unhide', 'delete', 'ban_author', 'unban_author'],
      responses: ['public_reply', 'private_reply'],
      ingestion: 'webhook',
      listSources: false,
      accountSelection: 'multiple',
      tokens: { refreshable: false, rotatesRefreshToken: false },
      apiHosts: ['graph.facebook.com'],
      authorizationHosts: ['www.facebook.com'],
      defaultScopes: [...FACEBOOK_SCOPES],
      requiredScopes: [...FACEBOOK_SCOPES],
    });
    expect(c.lifecycle).toBeDefined();
    expect(c.webhook?.signature.header).toBe('x-hub-signature-256');
  });
  it('refreshTokens is a typed auth failure (never refreshable)', async () => {
    await expect(c.refreshTokens(new Secret('x'), {} as never)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'not_refreshable',
    });
  });
});
