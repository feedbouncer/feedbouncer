import { describe, expect, it } from 'vitest';
import { orgApiStatus, userApiStatus } from './status.js';

describe.each([
  ['orgApiStatus', orgApiStatus],
  ['userApiStatus', userApiStatus],
])('%s', (_name, toApiStatus) => {
  it('maps exactly active to active', () => expect(toApiStatus('active')).toBe('active'));
  it.each(['suspended', 'Active', ' active', '', null, undefined, 1])('fails closed on %j', (raw) =>
    expect(toApiStatus(raw)).toBe('inactive'),
  );
});
