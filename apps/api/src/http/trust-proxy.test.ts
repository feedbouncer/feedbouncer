import { describe, expect, it } from 'vitest';
import { trustProxyHops } from './trust-proxy.js';

describe('trustProxyHops', () => {
  it('trusts nothing with 0 hops', () => {
    expect(trustProxyHops(0)).toBe(false);
  });

  it('trusts the first N hops when they are internal addresses', () => {
    const trust = trustProxyHops(1);
    if (typeof trust !== 'function') throw new Error('expected a function');
    for (const addr of [
      '127.0.0.1',
      '10.1.2.3',
      '172.18.0.5',
      '192.168.1.1',
      '::1',
      'fd00::1',
      '::ffff:172.18.0.5',
    ]) {
      expect(trust(addr, 0), addr).toBe(true);
    }
    expect(trust('172.18.0.5', 1)).toBe(false);
  });

  it('never trusts a public address as a proxy', () => {
    const trust = trustProxyHops(2);
    if (typeof trust !== 'function') throw new Error('expected a function');
    expect(trust('203.0.113.7', 0)).toBe(false);
    expect(trust('2001:db8::1', 0)).toBe(false);
    expect(trust('8.8.8.8', 1)).toBe(false);
    expect(trust('10.0.0.1', 1)).toBe(true);
    expect(trust('10.0.0.1', 2)).toBe(false);
  });

  it('rejects garbage', () => {
    const trust = trustProxyHops(1);
    if (typeof trust !== 'function') throw new Error('expected a function');
    expect(trust('not-an-ip', 0)).toBe(false);
    expect(trust('', 0)).toBe(false);
  });
});
