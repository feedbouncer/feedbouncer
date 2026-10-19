import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { describeFailure, toNodeApiError } from '../nodes/shared/errors';
import { API_KEY, fakeExecute } from './fakes';

const envelope = (code: string, message = 'boom') => ({ error: { code, message } });
const base = { credentialName: 'Prod', resourceLabel: 'comment', id: 'abc' };

describe('describeFailure', () => {
  it.each([
    [
      '401',
      { status: 401, body: envelope('unauthorized') },
      'FeedBouncer rejected the API key in credential "Prod".',
      'The key may be revoked or mistyped. Create a new key in FeedBouncer under Settings → API keys and update the credential.',
    ],
    [
      '403 insufficient_scope',
      { status: 403, body: envelope('insufficient_scope') },
      'The API key in credential "Prod" is read-only.',
      'This operation needs a Read and write key. Create one in FeedBouncer under Settings → API keys.',
    ],
    [
      '404 with an envelope',
      { status: 404, body: envelope('not_found') },
      'No comment with ID abc in this FeedBouncer workspace.',
      'Check the ID, or list comments to find current IDs.',
    ],
    [
      '404 version',
      { status: 404, body: 'Not Found', unsupported: true },
      'This FeedBouncer server does not support this operation yet.',
      'Update FeedBouncer. This node needs the API operations listed under "Supported versions" in its README.',
    ],
    [
      '429 exhausted',
      { status: 429, body: envelope('rate_limited'), retryAfterSeconds: 7 },
      'FeedBouncer rate limit reached.',
      "Retry after 7 seconds, or space requests out with the node's batching settings.",
    ],
    [
      'other 4xx with an envelope',
      { status: 422, body: envelope('invalid_request', 'limit must be at most 100') },
      'limit must be at most 100',
      'FeedBouncer error code: invalid_request.',
    ],
    [
      '3xx',
      { status: 302, body: '' },
      'FeedBouncer redirected the request.',
      "Set the credential's address to the final FeedBouncer address (redirects are not followed so your API key is not sent elsewhere).",
    ],
    [
      '5xx',
      { status: 503, body: envelope('internal') },
      'FeedBouncer returned an unexpected response (HTTP 503).',
      'Try again later. If it persists, check the FeedBouncer server logs.',
    ],
    [
      'non-JSON body',
      { status: 404, body: '<html>nope</html>' },
      'FeedBouncer returned an unexpected response (HTTP 404).',
      'Try again later. If it persists, check the FeedBouncer server logs.',
    ],
    [
      'ECONNREFUSED',
      { status: null, body: undefined, networkCode: 'ECONNREFUSED', host: 'fb.acme.io' },
      'Could not reach FeedBouncer at fb.acme.io.',
      'Check the address and that the server is running.',
    ],
    [
      'SELF_SIGNED_CERT_IN_CHAIN',
      { status: null, body: undefined, networkCode: 'SELF_SIGNED_CERT_IN_CHAIN' },
      "FeedBouncer's TLS certificate was not accepted.",
      'For a self-signed certificate turn on Ignore SSL Issues in the credential.',
    ],
  ])('%s', (_name, input, message, description) => {
    const info = describeFailure({ ...base, ...input } as Parameters<typeof describeFailure>[0]);
    expect(info.message).toBe(message);
    expect(info.description).toBe(description);
  });

  it('reports the status and API code', () => {
    expect(describeFailure({ ...base, status: 422, body: envelope('invalid_request') })).toMatchObject({
      httpCode: 422,
      code: 'invalid_request',
    });
  });

  it('cuts long API messages to 500 characters', () => {
    const info = describeFailure({ ...base, status: 400, body: envelope('invalid_request', 'x'.repeat(900)) });
    expect(info.message).toHaveLength(500);
  });

  it('removes anything key-shaped from API messages', () => {
    const echoed = envelope('invalid_request', `bad key ${API_KEY} / Bearer ${API_KEY}`);
    const info = describeFailure({ ...base, status: 400, body: echoed });
    expect(`${info.message}${info.description}`).not.toMatch(/AAAAAAAA|fbk_|Bearer/);
  });
});

describe('toNodeApiError', () => {
  it('keeps message, description and status, and carries no key or bearer text', () => {
    const info = describeFailure({ ...base, status: 401, body: envelope('unauthorized') });
    const error = toNodeApiError(fakeExecute().getNode(), info, 3);
    expect(error).toBeInstanceOf(NodeApiError);
    expect(error.message).toBe(info.message);
    expect(error.description).toBe(info.description);
    expect(error.httpCode).toBe('401');
    const dump = JSON.stringify(error) + String(error.stack);
    expect(dump).not.toContain('fbk_');
    expect(dump).not.toContain('Bearer');
  });
});
