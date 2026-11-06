import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverGet = vi.fn();
vi.mock('./server-api', () => ({ serverGet: (p: string) => serverGet(p) }));

import { invitationTokenFrom, invitationTokenFromNext, loadSignupEnabled } from './signup';

const VALID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  serverGet.mockReset();
});

describe('loadSignupEnabled', () => {
  it('is false only when the API says enabled is false', async () => {
    serverGet.mockResolvedValue({ status: 200, data: { enabled: false } });
    expect(await loadSignupEnabled()).toBe(false);
    expect(serverGet).toHaveBeenCalledWith('/api/v1/auth/sign-up');
  });

  it('is true when the API says enabled is true', async () => {
    serverGet.mockResolvedValue({ status: 200, data: { enabled: true } });
    expect(await loadSignupEnabled()).toBe(true);
  });

  it('is true when the API answers with an error', async () => {
    serverGet.mockResolvedValue({ status: 500, data: null });
    expect(await loadSignupEnabled()).toBe(true);
  });

  it('is true when the API cannot be reached', async () => {
    serverGet.mockRejectedValue(new Error('down'));
    expect(await loadSignupEnabled()).toBe(true);
  });
});

describe('invitationTokenFrom', () => {
  it('returns a 43-character base64url token', () => {
    expect(invitationTokenFrom(VALID)).toBe(VALID);
  });

  it.each([VALID.slice(1), '<script>', [VALID], undefined, `${VALID}!`])('rejects %j', (raw) => {
    expect(invitationTokenFrom(raw)).toBeNull();
  });
});

describe('invitationTokenFromNext', () => {
  it('reads the token of an invitation path', () => {
    expect(invitationTokenFromNext(`/invite?token=${VALID}`)).toBe(VALID);
  });

  it.each(['/orgs', null, '/invite?token=short', '//evil.com/invite?token=' + VALID])(
    'ignores %j',
    (next) => {
      expect(invitationTokenFromNext(next)).toBeNull();
    },
  );
});
