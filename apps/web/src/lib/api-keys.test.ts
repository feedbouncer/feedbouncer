import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api-client';
import {
  accessText,
  apiKeyErrorText,
  copyToken,
  lastUsedText,
  revokeConfirmText,
  statusText,
} from './api-keys';

describe('api key text', () => {
  it('labels access, status and last use', () => {
    expect(accessText('read')).toBe('Read only');
    expect(accessText('write')).toBe('Read and write');
    expect(statusText('active')).toBe('Active');
    expect(statusText('revoked')).toBe('Revoked');
    expect(lastUsedText(null)).toBe('Never');
    expect(lastUsedText('2026-01-02T03:04:05.000Z')).toBe('2026-01-02 03:04 UTC');
  });

  it('confirms revocation by key name', () => {
    expect(revokeConfirmText('CI')).toBe(
      'Revoke CI? Apps using this key will stop working immediately.',
    );
  });

  it('shows the API message for API errors and a generic one otherwise', () => {
    expect(
      apiKeyErrorText(
        new ApiRequestError(409, 'api_key_name_taken', 'An active API key already uses this name.'),
      ),
    ).toBe('An active API key already uses this name.');
    expect(apiKeyErrorText(new TypeError('x'))).toBe('Something went wrong.');
  });
});

describe('copyToken', () => {
  it('confirms a successful copy', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(copyToken(write, 'fbk_x')).resolves.toBe('Copied.');
    expect(write).toHaveBeenCalledWith('fbk_x');
  });

  it('asks for a manual copy when the clipboard rejects', async () => {
    const write = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(copyToken(write, 'fbk_x')).resolves.toBe(
      'Copy failed. Select and copy the key manually.',
    );
  });
});
