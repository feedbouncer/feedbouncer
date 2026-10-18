import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError } from '@feedbouncer/jobs';
import { defaultOutDir, ensureDefaultParent, evalExportCommand } from './eval-export.js';
import type { OpsContext } from './ops-context.js';

const ORG = '1b4e28ba-2fa1-4d2b-8f3e-1c6a2d9e7f10';

const ctx = (): OpsContext => ({
  log: { debug() {}, info() {}, warn() {}, error() {} },
  env: {},
  out: () => {},
  pool: () => {
    throw new Error('database must not be used');
  },
  producer: () => {
    throw new Error('producer must not be used');
  },
});

describe('eval-export default output', () => {
  it('is tmp/eval/<UTC timestamp>', () => {
    expect(defaultOutDir(new Date('2026-10-18T09:05:07.123Z'))).toBe(
      join('tmp', 'eval', '20261018T090507Z'),
    );
  });

  it('creates a missing parent privately, recursively and idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-default-'));
    const out = join(root, 'tmp', 'eval', '20261018T090507Z');
    await ensureDefaultParent(out);
    await ensureDefaultParent(out);
    const s = await stat(join(root, 'tmp', 'eval'));
    expect(s.isDirectory()).toBe(true);
    expect(s.mode & 0o077).toBe(0);
  });
});

describe('eval-export argument validation', () => {
  const ok = ['--org', ORG, '--from', '2026-10-01', '--to', '2026-10-08'];
  it.each([
    ['non-uuid org', ['--org', 'nope', '--from', '2026-10-01', '--to', '2026-10-08']],
    ['no org', ['--from', '2026-10-01', '--to', '2026-10-08']],
    ['non-uuid brand', [...ok, '--brand', 'x']],
    ['from equal to', ['--org', ORG, '--from', '2026-10-08', '--to', '2026-10-08']],
    ['from after to', ['--org', ORG, '--from', '2026-10-09', '--to', '2026-10-08']],
    ['bad date', ['--org', ORG, '--from', '2026-02-31', '--to', '2026-10-08']],
    ['to in the far future', ['--org', ORG, '--from', '2026-10-01', '--to', '2999-01-01']],
    ['sample 0', [...ok, '--label-sample', '0']],
    ['sample too big', [...ok, '--label-sample', '100001']],
    ['sample not an integer', [...ok, '--label-sample', '1.5']],
    ['negative seed', [...ok, '--seed', '-1']],
    ['seed too big', [...ok, '--seed', '4294967296']],
    ['unknown flag', [...ok, '--x', '1']],
    ['missing parent', [...ok, '--out', '/nonexistent-parent-dir/run']],
  ])('rejects %s', async (_name, argv) => {
    await expect(evalExportCommand(argv, ctx())).rejects.toBeInstanceOf(UsageError);
  });
});
