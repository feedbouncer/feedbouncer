import { describe, expect, it } from 'vitest';
import { checkUrlSyntax, isAllowedAddress, validateWebhookUrl } from './destination.js';

describe('checkUrlSyntax', () => {
  it.each([
    'https://2130706433/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::1]/',
    'https://0.0.0.0/',
    'https://169.254.169.254/latest',
    'https://10.0.0.1/',
    'https://100.64.0.1/',
    'https://[fd00::1]/',
    'https://0x7f.1/',
    'https://127.1/',
  ])('rejects %s as a private address', (u) => {
    expect(checkUrlSyntax(u)).toEqual({ ok: false, reason: 'private_address' });
  });

  it.each([
    ['http://example.com/', 'not_https'],
    ['https://u:p@example.com/', 'has_credentials'],
    ['https://u@example.com/', 'has_credentials'],
    ['https://example.com:8443/', 'port_not_allowed'],
    ['https://intranet/', 'host_not_allowed'],
    ['https://localhost/', 'host_not_allowed'],
    ['https://a.localhost/', 'host_not_allowed'],
    ['https://a.localhost./', 'host_not_allowed'],
    ['https://a.localhost../', 'host_not_allowed'],
    ['https://intranet../', 'host_not_allowed'],
    [`https://example.com/${' '.repeat(800)}x`, 'too_long'],
    ['not a url', 'invalid'],
    [`https://example.com/${'a'.repeat(2030)}`, 'too_long'],
  ])('rejects %s with %s', (u, reason) => {
    expect(checkUrlSyntax(u)).toEqual({ ok: false, reason });
  });

  it('accepts a public https url, explicit 443 and strips the fragment', () => {
    const r = checkUrlSyntax('https://example.com:443/hook?a=1#frag');
    expect(r.ok && r.url.href).toBe('https://example.com/hook?a=1');
  });

  it('accepts a public IP literal', () => {
    expect(checkUrlSyntax('https://93.184.215.14/').ok).toBe(true);
  });
});

describe('isAllowedAddress', () => {
  it('allows only unicast unless inside an allowed cidr', () => {
    expect(isAllowedAddress('93.184.215.14', [])).toBe(true);
    expect(isAllowedAddress('::ffff:10.0.0.1', [])).toBe(false);
    expect(isAllowedAddress('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isAllowedAddress('11.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isAllowedAddress('192.168.1.1', ['10.0.0.0/8'])).toBe(false);
    expect(isAllowedAddress('garbage', [])).toBe(false);
  });
});

describe('invalid allowed cidrs', () => {
  it('fail loudly instead of being skipped', async () => {
    expect(() =>
      checkUrlSyntax('https://example.com/', { allowedPrivateCidrs: ['nope'] }),
    ).toThrow();
    await expect(
      validateWebhookUrl('https://example.com/', {
        resolve: async () => ['1.1.1.1'],
        allowedPrivateCidrs: ['nope'],
      }),
    ).rejects.toThrow();
  });
});

describe('validateWebhookUrl', () => {
  const url = 'https://hooks.example.com/x';

  it('rejects when any resolved address is private', async () => {
    const r = await validateWebhookUrl(url, {
      resolve: async () => ['93.184.215.14', '10.1.2.3'],
      allowedPrivateCidrs: [],
    });
    expect(r).toEqual({ ok: false, reason: 'private_address' });
  });

  it('reports unresolvable hosts', async () => {
    const r = await validateWebhookUrl(url, {
      resolve: async () => {
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      },
      allowedPrivateCidrs: [],
    });
    expect(r).toEqual({ ok: false, reason: 'unresolvable' });
  });

  it('treats an empty answer as unresolvable', async () => {
    const r = await validateWebhookUrl(url, { resolve: async () => [], allowedPrivateCidrs: [] });
    expect(r).toEqual({ ok: false, reason: 'unresolvable' });
  });

  it('honours allowed private cidrs', async () => {
    const r = await validateWebhookUrl(url, {
      resolve: async () => ['10.1.2.3'],
      allowedPrivateCidrs: ['10.0.0.0/8'],
    });
    expect(r.ok).toBe(true);
  });

  it('does not resolve IP literals or syntactically bad urls', async () => {
    const resolve = async () => {
      throw new Error('should not resolve');
    };
    expect(
      (await validateWebhookUrl('https://93.184.215.14/', { resolve, allowedPrivateCidrs: [] })).ok,
    ).toBe(true);
    expect(await validateWebhookUrl('http://x.com/', { resolve, allowedPrivateCidrs: [] })).toEqual(
      {
        ok: false,
        reason: 'not_https',
      },
    );
  });
});
