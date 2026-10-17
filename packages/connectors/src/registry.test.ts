import { describe, expect, it } from 'vitest';
import type { Connector } from './connector.js';
import { ConnectorError } from './errors.js';
import { ConnectorRegistry, validateConnector } from './registry.js';

const base = (): Connector => ({
  platform: 'youtube',
  capabilities: {
    actions: ['hide', 'delete'],
    listSources: false,
    recentSources: false,
    ingestion: 'polling',
    tokens: { refreshable: true, rotatesRefreshToken: false },
    rateLimit: { points: 10, durationSec: 60, urgentReservePoints: 2, defaultRetryAfterMs: 5_000 },
    apiHosts: ['api.example.test'],
    authorizationHosts: ['auth.example.test'],
    defaultScopes: ['comments'],
    maxPageSize: 50,
  },
  buildAuthorizationUrl: () => new URL('https://auth.example.test/authorize'),
  exchangeCode: async () => {
    throw new Error('unused');
  },
  refreshTokens: async () => {
    throw new Error('unused');
  },
  listComments: async () => ({ items: [], nextCursor: null }),
  getComment: async () => null,
  act: async () => ({ status: 'not_found' }),
});
const withCaps = (patch: Partial<Connector['capabilities']>): Connector => {
  const c = base();
  return { ...c, capabilities: { ...c.capabilities, ...patch } };
};

describe('validateConnector', () => {
  it('accepts a well-formed connector', () => {
    expect(() => validateConnector(base())).not.toThrow();
  });

  it('a polling-only connector with no actions validates', () => {
    const c = {
      ...withCaps({ actions: [], ingestion: 'polling', listSources: true }),
      listSources: async () => ({ items: [], nextCursor: null }),
    };
    expect(() => validateConnector(c)).not.toThrow();
  });

  it.each([
    ['unknown platform', { ...base(), platform: 'myspace' as never }, /platform/],
    ['required scope not requested', withCaps({ requiredScopes: ['other'] }), /requiredScopes/],
    [
      'multiple selection without listAccounts',
      withCaps({ accountSelection: 'multiple' }),
      /accountSelection/,
    ],
    ['responses without respond()', withCaps({ responses: ['public_reply'] }), /responses/],
    [
      'unknown response kind',
      {
        ...withCaps({ responses: ['dm' as never] }),
        respond: async () => ({ status: 'not_found' as const }),
      },
      /responses/,
    ],
    ['unknown action', withCaps({ actions: ['hide', 'nuke' as never] }), /actions/],
    ['duplicate action', withCaps({ actions: ['hide', 'hide'] }), /actions/],
    [
      'reserve >= points',
      withCaps({
        rateLimit: {
          points: 5,
          durationSec: 60,
          urgentReservePoints: 5,
          defaultRetryAfterMs: 1000,
        },
      }),
      /rateLimit/,
    ],
    [
      'non-integer points',
      withCaps({
        rateLimit: {
          points: 1.5,
          durationSec: 60,
          urgentReservePoints: 0,
          defaultRetryAfterMs: 1000,
        },
      }),
      /rateLimit/,
    ],
    ['uppercase host', withCaps({ apiHosts: ['API.example.test'] }), /apiHosts/],
    ['host with scheme', withCaps({ apiHosts: ['https://api.example.test'] }), /apiHosts/],
    ['no api hosts', withCaps({ apiHosts: [] }), /apiHosts/],
    ['page size 0', withCaps({ maxPageSize: 0 }), /maxPageSize/],
    [
      'rotation without refresh',
      withCaps({ tokens: { refreshable: false, rotatesRefreshToken: true } }),
      /tokens/,
    ],
    ['webhook ingestion without spec', withCaps({ ingestion: 'webhook' }), /webhook/],
    ['listSources flag without method', withCaps({ listSources: true }), /listSources/],
    ['recentSources flag without method', withCaps({ recentSources: true }), /recentSources/],
    [
      'listRecentSources method without flag',
      { ...base(), listRecentSources: async () => ({ items: [], nextCursor: null }) },
      /recentSources/,
    ],
    ['adLookup flag without method', withCaps({ adLookup: true }), /adLookup/],
    [
      'lookupAd method without flag',
      { ...base(), lookupAd: async () => ({ name: null, deleted: false }) },
      /adLookup/,
    ],
    [
      'zero private reply window',
      withCaps({ constraints: { privateReplyWindowMs: 0 } }),
      /constraints/,
    ],
    [
      'reply limit above 8000',
      {
        ...withCaps({
          responses: ['public_reply'],
          constraints: { maxReplyChars: { public_reply: 9000 } },
        }),
        respond: async () => ({ status: 'not_found' as const }),
      },
      /constraints/,
    ],
    [
      'reply limit for an undeclared response',
      withCaps({ constraints: { maxReplyChars: { private_reply: 100 } } }),
      /constraints/,
    ],
    [
      'backgroundPoints above bulk',
      withCaps({
        rateLimit: {
          points: 10,
          durationSec: 60,
          urgentReservePoints: 2,
          defaultRetryAfterMs: 60_000,
          backgroundPoints: 9,
        },
      }),
      /rateLimit/,
    ],
    ['listReplies is not a function', { ...withCaps({}), listReplies: 1 as never }, /listReplies/],
  ])('rejects %s', (_n, c, msg) => {
    expect(() => validateConnector(c)).toThrow(msg);
  });
});

describe('ConnectorRegistry', () => {
  it('registers once per platform', () => {
    const r = new ConnectorRegistry();
    r.register(base());
    expect(r.get('youtube')?.platform).toBe('youtube');
    expect(() => r.register(base())).toThrow(/already registered/);
    expect(r.platforms()).toEqual(['youtube']);
  });

  it('require() throws a typed unsupported error for unknown platforms', () => {
    const r = new ConnectorRegistry();
    expect(() => r.require('tiktok')).toThrow(ConnectorError);
    try {
      r.require('tiktok');
    } catch (e) {
      expect((e as ConnectorError).kind).toBe('unsupported');
    }
  });

  it('accepts the full extended shape', () => {
    const c: Connector = {
      ...withCaps({
        requiredScopes: ['comments'],
        accountSelection: 'multiple',
        responses: ['public_reply', 'private_reply'],
      }),
      listAccounts: async () => [],
      respond: async () => ({ status: 'not_found' }),
      lifecycle: { onConnected: async () => {}, onDisconnected: async () => {} },
    };
    expect(() => validateConnector(c)).not.toThrow();
  });

  it('accepts Instagram-style constraints', () => {
    const c: Connector = {
      ...withCaps({
        responses: ['public_reply', 'private_reply'],
        constraints: {
          privateReplyWindowMs: 7 * 86_400_000,
          privateReplyTopLevelOnly: true,
          publicReplyOnHidden: false,
          hideOwnAccountComments: false,
          maxReplyChars: { public_reply: 2200, private_reply: 1000 },
        },
      }),
      respond: async () => ({ status: 'not_found' }),
      listReplies: async () => ({ items: [], nextCursor: null }),
    };
    expect(() => validateConnector(c)).not.toThrow();
  });
});
