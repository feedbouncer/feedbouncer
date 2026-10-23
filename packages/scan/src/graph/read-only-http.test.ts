import { describe, expect, it, vi } from 'vitest';
import { ConnectorError, type SafeHttp } from '@feedbouncer/connectors';
import { readOnlyHttp } from './read-only-http.js';

const signal = new AbortController().signal;
const response = { status: 200, headers: new Headers(), body: '{}' };

describe('readOnlyHttp', () => {
  it('rejects POST and DELETE without calling inner', async () => {
    const inner: SafeHttp = { request: vi.fn(async () => response) };
    const http = readOnlyHttp(inner);
    for (const method of ['POST', 'DELETE'] as const) {
      await expect(
        http.request({ method, url: 'https://graph.facebook.com/v26.0/1' }, signal),
      ).rejects.toMatchObject({
        constructor: ConnectorError,
        kind: 'permanent',
        code: 'scan_write_forbidden',
      });
    }
    expect(inner.request).not.toHaveBeenCalled();
  });

  it('passes GET through', async () => {
    const inner: SafeHttp = { request: vi.fn(async () => response) };
    const req = { method: 'GET', url: 'https://graph.facebook.com/v26.0/1' } as const;
    await expect(readOnlyHttp(inner).request(req, signal)).resolves.toBe(response);
    expect(inner.request).toHaveBeenCalledWith(req, signal);
  });
});
