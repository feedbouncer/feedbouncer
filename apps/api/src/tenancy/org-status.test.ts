import { describe, expect, it } from 'vitest';
import { enforceOrgActive } from './org-status.js';

const fakeLog = () => {
  const calls: [string, string, unknown][] = [];
  return {
    calls,
    info: (m: string, f?: unknown) => void calls.push(['info', m, f]),
    error: (m: string, f?: unknown) => void calls.push(['error', m, f]),
  };
};
const check = (rawStatus: unknown) => ({
  organizationId: 'org-1',
  rawStatus,
  via: 'session' as const,
  route: 'GET /x',
  userId: 'u-1',
});

describe('enforceOrgActive', () => {
  it('active passes silently', () => {
    const log = fakeLog();
    expect(() => enforceOrgActive(log, check('active'))).not.toThrow();
    expect(log.calls).toHaveLength(0);
  });

  it('suspended throws 403 organization_suspended and logs one info line', () => {
    const log = fakeLog();
    expect(() => enforceOrgActive(log, check('suspended'))).toThrow(
      expect.objectContaining({ status: 403, code: 'organization_suspended' }),
    );
    expect(log.calls).toEqual([
      [
        'info',
        'org.access_denied_suspended',
        { orgId: 'org-1', via: 'session', route: 'GET /x', userId: 'u-1' },
      ],
    ]);
  });

  it.each([null, 'paused'])('%j fails closed and logs an error without the raw value', (raw) => {
    const log = fakeLog();
    expect(() => enforceOrgActive(log, check(raw))).toThrow(
      expect.objectContaining({ status: 403, code: 'organization_suspended' }),
    );
    expect(log.calls).toContainEqual([
      'error',
      'org.status_unrecognized',
      { orgId: 'org-1', via: 'session' },
    ]);
    expect(JSON.stringify(log.calls)).not.toContain('paused');
  });
});
