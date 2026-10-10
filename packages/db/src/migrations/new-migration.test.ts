import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createMigration } from './new-migration.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fb-new-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it('creates <UTC timestamp>_<name> with migration.sql and down.sql templates', async () => {
  const name = await createMigration(dir, 'add_widget', new Date('2026-10-12T08:09:10Z'));
  expect(name).toBe('20261012080910_add_widget');
  expect((await readdir(path.join(dir, name))).sort()).toEqual(['down.sql', 'migration.sql']);
  expect(await readFile(path.join(dir, name, 'migration.sql'), 'utf8')).toMatch(
    /BEGIN;\nSET LOCAL lock_timeout = '10s';[\s\S]*COMMIT;\n$/,
  );
  expect(await readFile(path.join(dir, name, 'down.sql'), 'utf8')).toMatch(
    /Reverse every statement/,
  );
});

it.each(['', 'Add-Widget', '../evil', 'a/b', 'x'.repeat(61), 'name with space'])(
  'rejects unsafe name %j',
  async (bad) => {
    await expect(createMigration(dir, bad)).rejects.toThrow(/name must match/);
    expect(await readdir(dir)).toEqual([]);
  },
);

it('refuses a timestamp not newer than the latest existing migration', async () => {
  await createMigration(dir, 'first', new Date('2026-10-12T08:09:10Z'));
  await expect(createMigration(dir, 'second', new Date('2026-10-12T08:09:10Z'))).rejects.toThrow(
    /newer than/,
  );
});
