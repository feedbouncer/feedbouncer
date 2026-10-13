import { expect, it } from 'vitest';
import type { Logger } from '@feedbouncer/service-runtime';
import { diagToLogger } from './diag.js';

function capture(): { log: Logger; details: string[] } {
  const details: string[] = [];
  const log = {
    debug() {},
    info() {},
    error() {},
    warn(_m: string, f?: Record<string, unknown>) {
      details.push(String(f?.detail));
    },
  } as Logger;
  return { log, details };
}

const SECRETS = ['s3cr3tpassw0rd', 'hunter2hunter2', 'abcdef0123456789abcdef0123456789'];

it('redacts credentials that straddle the 120 character cut', () => {
  const cases = [
    (pad: string) => `${pad}https://user:${SECRETS[0]}@collector.example/v1/traces`,
    (pad: string) => `${pad}password=${SECRETS[1]} next`,
    (pad: string) => `${pad}Authorization: Bearer ${SECRETS[2]}`,
  ];
  for (const make of cases) {
    for (let pad = 90; pad <= 125; pad++) {
      const { log, details } = capture();
      diagToLogger(log).error(make('x'.repeat(pad)));
      expect(details).toHaveLength(1);
      for (const s of SECRETS) {
        for (let n = 4; n <= s.length; n++) {
          expect(details[0]).not.toContain(s.slice(0, n));
        }
      }
    }
  }
});

it('never throws when the log sink throws', () => {
  const log = {
    debug() {},
    info() {},
    error() {},
    warn() {
      throw new Error('sink down');
    },
  } as Logger;
  expect(() => diagToLogger(log).error('boom')).not.toThrow();
});

it('rate limits identical messages for 60 seconds', () => {
  const { log, details } = capture();
  let t = 0;
  const d = diagToLogger(log, () => t);
  d.warn('same');
  d.warn('same');
  t = 61_000;
  d.warn('same');
  expect(details).toHaveLength(2);
});
