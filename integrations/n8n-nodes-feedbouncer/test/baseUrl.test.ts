import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl } from '../nodes/shared/baseUrl';

const HTTPS_MESSAGE =
  'The FeedBouncer address must start with https://. To use http://, turn on Allow Plain HTTP.';
const EXAMPLE_MESSAGE =
  'Enter the address of your FeedBouncer, for example https://feedbouncer.acme.io.';

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://fb.acme.io/', false, 'https://fb.acme.io'],
    ['https://fb.acme.io/feedbouncer/', false, 'https://fb.acme.io/feedbouncer'],
    ['https://fb.acme.io//x//', false, 'https://fb.acme.io/x'],
    ['  https://fb.acme.io  ', false, 'https://fb.acme.io'],
    ['https://fb.acme.io/v1/', false, 'https://fb.acme.io'],
    ['http://10.0.0.5:3000', true, 'http://10.0.0.5:3000'],
  ])('normalises %j (allowHttp=%s)', (raw, allowHttp, url) => {
    expect(normalizeBaseUrl(raw, allowHttp)).toEqual({ ok: true, url });
  });

  it('rejects http when plain HTTP is off', () => {
    expect(normalizeBaseUrl('http://fb.acme.io', false)).toEqual({ ok: false, message: HTTPS_MESSAGE });
  });

  it('rejects other schemes even with plain HTTP on', () => {
    expect(normalizeBaseUrl('ftp://fb.acme.io', true)).toEqual({ ok: false, message: HTTPS_MESSAGE });
  });

  it('rejects credentials without echoing them', () => {
    const result = normalizeBaseUrl('https://u:pw@fb.acme.io', false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        'Remove the user name, password, query or # part from the FeedBouncer address.',
      );
      expect(result.message).not.toContain('pw');
    }
  });

  it('rejects a query or fragment', () => {
    expect(normalizeBaseUrl('https://fb.acme.io/?x=1#y', false).ok).toBe(false);
  });

  it('rejects input that is not a URL', () => {
    expect(normalizeBaseUrl('fb.acme.io', false)).toEqual({ ok: false, message: EXAMPLE_MESSAGE });
  });
});
