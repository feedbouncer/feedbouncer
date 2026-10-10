import { describe, expect, it } from 'vitest';
import { apiInternalUrl } from './api-url';

describe('apiInternalUrl', () => {
  it('returns null when unset', () => {
    expect(apiInternalUrl({})).toBeNull();
  });
  it('accepts http and https', () => {
    expect(apiInternalUrl({ API_INTERNAL_URL: 'http://api:3001' })?.host).toBe('api:3001');
    expect(apiInternalUrl({ API_INTERNAL_URL: 'https://api.example' })?.protocol).toBe('https:');
  });
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'gopher://x', 'not a url'])(
    'rejects %s',
    (value) => {
      expect(apiInternalUrl({ API_INTERNAL_URL: value })).toBeNull();
    },
  );
});
