import { describe, expect, it } from 'vitest';
import { fromApiStatus, orgApiStatus, userApiStatus } from './status.js';

describe.each([
  ['orgApiStatus', orgApiStatus],
  ['userApiStatus', userApiStatus],
])('%s', (_name, toApiStatus) => {
  it('maps exactly active to active', () => expect(toApiStatus('active')).toBe('active'));
  it.each(['suspended', 'Active', ' active', '', null, undefined, 1])('fails closed on %j', (raw) =>
    expect(toApiStatus(raw)).toBe('inactive'),
  );
});

it('fromApiStatus maps to the stored status', () => {
  expect([fromApiStatus('active'), fromApiStatus('inactive')]).toEqual(['active', 'suspended']);
});
