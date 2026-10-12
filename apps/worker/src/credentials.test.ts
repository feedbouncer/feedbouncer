import { describe, expect, it, vi } from 'vitest';
import { CredentialUnreadableError, type markReconnectRequired } from '@feedbouncer/secrets';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { useConnectionCredentials } from './credentials.js';

const scope = { organizationId: 'o1', brandId: 'b1', connectionId: 'c1' };
const TOKEN = 'worker-sentinel-token-123456789';

function deps(withCredentials: () => Promise<unknown>) {
  const lines: string[] = [];
  const markReconnect = vi.fn<typeof markReconnectRequired>(async () => true);
  return {
    lines,
    markReconnect,
    deps: {
      store: { withCredentials: withCredentials as never },
      db: { query: vi.fn() as never },
      log: createLogger('t', 'debug', (l) => lines.push(l)),
      markReconnect,
    },
  };
}

describe('useConnectionCredentials', () => {
  it('returns the callback result on success', async () => {
    const d = deps(async () => 'posted');
    expect(
      await useConnectionCredentials(d.deps, scope, ['access_token'], async () => 'posted'),
    ).toEqual({ ok: true, value: 'posted' });
    expect(d.markReconnect).not.toHaveBeenCalled();
  });

  it('flags the connection and returns a handled failure for unreadable credentials (no throw, no crash)', async () => {
    const d = deps(async () => {
      throw new CredentialUnreadableError('tampered', 'k1');
    });
    const r = await useConnectionCredentials(d.deps, scope, ['access_token'], async () => 'never');
    expect(r).toEqual({ ok: false, reason: 'tampered' });
    expect(d.markReconnect).toHaveBeenCalledOnce();
    expect(d.markReconnect.mock.calls[0]![1]).toEqual(scope);
    const line = JSON.parse(d.lines[0]!);
    expect(line).toMatchObject({
      level: 'warn',
      connectionId: 'c1',
      reason: 'tampered',
      keyId: 'k1',
    });
  });

  it('propagates unrelated errors (they go through normal job retry)', async () => {
    const d = deps(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      useConnectionCredentials(d.deps, scope, ['access_token'], async () => 'x'),
    ).rejects.toThrow('ECONNRESET');
  });

  it('never logs the credential', async () => {
    const d = deps(async () => {
      throw new CredentialUnreadableError('unknown_key', 'k0');
    });
    await useConnectionCredentials(d.deps, scope, ['access_token'], async () => new Secret(TOKEN));
    expect(d.lines.join('\n')).not.toContain(TOKEN);
  });
});
