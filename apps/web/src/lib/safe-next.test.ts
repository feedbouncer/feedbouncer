import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it.each([
    ['/orgs/123', '/orgs/123'],
    ['/invite?token=abc', '/invite?token=abc'],
    [null, '/orgs'],
    [undefined, '/orgs'],
    ['', '/orgs'],
    ['https://evil.test', '/orgs'],
    ['//evil.test', '/orgs'],
    ['/\\evil.test', '/orgs'],
    ['javascript:alert(1)', '/orgs'],
    ['/%2F%2Fevil.test', '/%2F%2Fevil.test'],
    ['/.//evil.com', '/orgs'],
    ['/a/..//evil.com', '/orgs'],
    ['/%2e//evil.com', '/orgs'],
    ['/./\\evil.com', '/orgs'],
    ['/\tevil.com', '/orgs'],
    ['/orgs\n/x', '/orgs'],
    ['/a\\b', '/orgs'],
  ])('%j -> %j', (raw, want) => {
    expect(safeNextPath(raw)).toBe(want);
  });

  it('uses the given fallback', () => {
    expect(safeNextPath('//evil.test', '/account')).toBe('/account');
  });
});
