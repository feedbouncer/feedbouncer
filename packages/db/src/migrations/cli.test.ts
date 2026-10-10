import { describe, expect, it } from 'vitest';
import { main } from './cli.js';

function capture() {
  const lines: string[] = [];
  return { out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }, lines };
}

describe('cli', () => {
  it('prints usage and exits 2 for an unknown command', async () => {
    const c = capture();
    expect(await main(['frobnicate'], {}, c.out)).toBe(2);
    expect(c.lines.join('\n')).toMatch(/usage/i);
  });

  it('down refuses without --yes-destroy-data and never connects', async () => {
    const c = capture();
    expect(
      await main(['down'], { DATABASE_URL: 'postgresql://u:hunter2@127.0.0.1:1/db' }, c.out),
    ).toBe(2);
    expect(c.lines.join('\n')).toMatch(/--yes-destroy-data/);
  });

  it('down names a missing or invalid DATABASE_URL without echoing its value', async () => {
    const c = capture();
    expect(
      await main(['down', '--yes-destroy-data'], { DATABASE_URL: 'mysql://u:hunter2@h/db' }, c.out),
    ).toBe(1);
    const text = c.lines.join('\n');
    expect(text).toMatch(/DATABASE_URL/);
    expect(text).not.toMatch(/hunter2/);
  });

  it('down reports a connection failure without leaking the password', async () => {
    const c = capture();
    // Port 1 on loopback: connection refused quickly.
    expect(
      await main(
        ['down', '--yes-destroy-data'],
        { DATABASE_URL: 'postgresql://u:hunter2@127.0.0.1:1/db' },
        c.out,
      ),
    ).toBe(1);
    expect(c.lines.join('\n')).not.toMatch(/hunter2/);
  });

  it('new requires exactly one name', async () => {
    const c = capture();
    expect(await main(['new'], {}, c.out)).toBe(2);
  });
});
