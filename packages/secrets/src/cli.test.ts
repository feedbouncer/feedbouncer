import { describe, expect, it } from 'vitest';
import { main } from './cli.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe('secrets CLI', () => {
  it('keygen prints exactly one <id>:<base64 32 bytes> line on stdout', async () => {
    const t = io();
    expect(await main(['keygen', '--id', 'k2026b'], {}, t.io)).toBe(0);
    expect(t.out).toHaveLength(1);
    expect(t.out[0]).toMatch(/^k2026b:[A-Za-z0-9+/]{43}=$/);
  });

  it('keygen defaults the id to k<yyyymmdd> and produces a different key each time', async () => {
    const a = io();
    const b = io();
    await main(['keygen'], {}, a.io);
    await main(['keygen'], {}, b.io);
    expect(a.out[0]).toMatch(/^k\d{8}:/);
    expect(a.out[0]).not.toBe(b.out[0]);
  });

  it('rejects a bad key id and unknown commands with exit 2', async () => {
    expect(await main(['keygen', '--id', 'Bad_Id'], {}, io().io)).toBe(2);
    expect(await main(['frobnicate'], {}, io().io)).toBe(2);
    expect(await main([], {}, io().io)).toBe(2);
    expect(await main(['reencrypt', '--batch-size', '0'], {}, io().io)).toBe(2);
    expect(await main(['reencrypt', '--batch-size'], {}, io().io)).toBe(2);
  });

  it('reports config errors by setting name, never by value', async () => {
    const t = io();
    const code = await main(
      ['status'],
      {
        DATABASE_URL: 'postgresql://u:hunter2-pw@h/db',
        FB_ENCRYPTION_KEYS: 'k1:not-base64-hunter3',
        FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
        FB_ENV: 'test',
      },
      t.io,
    );
    expect(code).toBe(1);
    const all = [...t.out, ...t.err].join('\n');
    expect(all).toMatch(/FB_ENCRYPTION_KEYS/);
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('hunter3');
  });

  it('a missing DATABASE_URL is reported by name with exit 1', async () => {
    const t = io();
    expect(await main(['verify'], { FB_ENV: 'test' }, t.io)).toBe(1);
    expect([...t.out, ...t.err].join('\n')).toMatch(/DATABASE_URL/);
  });
});
