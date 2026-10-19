import { describe, expect, it } from 'vitest';
import { classifyError } from './transport.js';

const withCode = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: { code } });

describe('classifyError', () => {
  it.each([
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_GET_ISSUER_CERT',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ])('maps %s to tls_error', (code) => {
    expect(classifyError(withCode(code))).toBe('tls_error');
  });

  it('keeps the other classes', () => {
    expect(classifyError(withCode('ENOTFOUND'))).toBe('dns_error');
    expect(classifyError(withCode('UND_ERR_HEADERS_TIMEOUT'))).toBe('timeout');
    expect(classifyError(withCode('ECONNREFUSED'))).toBe('connection_error');
  });
});
