import { describe, expect, it } from 'vitest';
import { clientIpKey } from './client-ip.js';

describe('clientIpKey', () => {
  it('keeps IPv4 as is', () => expect(clientIpKey('203.0.113.7')).toBe('203.0.113.7'));
  it('reduces IPv6 to its /64 prefix', () =>
    expect(clientIpKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64'));
  it('unwraps IPv4-mapped IPv6', () =>
    expect(clientIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7'));
  it('maps garbage to unknown', () => expect(clientIpKey('garbage')).toBe('unknown'));
});
