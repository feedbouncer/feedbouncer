import { describe, expect, it } from 'vitest';
import { FeedBouncerApi } from '../credentials/FeedBouncerApi.credentials';

const credential = new FeedBouncerApi();

describe('FeedBouncerApi credential', () => {
  it('has the expected name', () => {
    expect(credential.name).toBe('feedBouncerApi');
  });

  it('masks the API key', () => {
    const apiKey = credential.properties.find((p) => p.name === 'apiKey');
    expect(apiKey?.typeOptions?.password).toBe(true);
  });

  it('sends the key as a bearer token', () => {
    expect(credential.authenticate).toMatchObject({
      properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
    });
  });

  it('tests the key against /v1/key', () => {
    expect(credential.test.request.url).toBe('/v1/key');
  });

  const testBaseUrl = (credentials: Record<string, unknown>): unknown => {
    const expression = String(credential.test.request.baseURL).replace(/^=\{\{|\}\}$/g, '');
    // eslint-disable-next-line @n8n/community-nodes/no-dangerous-functions -- evaluates the credential's own expression
    return new Function('$credentials', `return ${expression};`)(credentials);
  };
  const UNUSABLE = 'invalid://address';

  it('builds the test base URL without trailing slashes or /v1', () => {
    expect(testBaseUrl({ baseUrl: 'https://fb.acme.io/x/' })).toBe('https://fb.acme.io/x');
    expect(testBaseUrl({ baseUrl: ' https://fb.acme.io/v1/ ' })).toBe('https://fb.acme.io');
    expect(testBaseUrl({ baseUrl: 'https://fb.acme.io' })).toBe('https://fb.acme.io');
    expect(testBaseUrl({ baseUrl: 'https://fb.acme.io/x/v1' })).toBe('https://fb.acme.io/x');
  });

  it('only sends over http when Allow Plain HTTP is on', () => {
    expect(testBaseUrl({ baseUrl: 'http://fb.acme.io', allowHttp: false })).toBe(UNUSABLE);
    expect(testBaseUrl({ baseUrl: 'http://fb.acme.io' })).toBe(UNUSABLE);
    expect(testBaseUrl({ baseUrl: 'http://fb.acme.io/v1/', allowHttp: true })).toBe('http://fb.acme.io');
  });

  it.each([
    'https://user:pw@fb.acme.io',
    'https://user@fb.acme.io',
    'https://fb.acme.io?a=1',
    'https://fb.acme.io/x#frag',
    'ftp://fb.acme.io',
    'fb.acme.io',
    '',
  ])('refuses to send the key to %j', (baseUrl) => {
    expect(testBaseUrl({ baseUrl, allowHttp: true })).toBe(UNUSABLE);
  });

  it('does not follow redirects and times out', () => {
    expect(credential.test.request).toMatchObject({ disableFollowRedirect: true, timeout: 30000 });
  });

  it('explains 401 and 404 test failures', () => {
    expect(credential.test.rules).toEqual([
      {
        type: 'responseCode',
        properties: {
          value: 401,
          message:
            'FeedBouncer rejected this API key. It may be revoked or mistyped. Create a new key in FeedBouncer under Settings → API keys.',
        },
      },
      {
        type: 'responseCode',
        properties: {
          value: 404,
          message:
            'No FeedBouncer API found at this address, or the server is older than this node supports. Check the address (the one you sign in at).',
        },
      },
    ]);
  });
});
