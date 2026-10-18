import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultOutDir, ensureDefaultParent } from './eval-export.js';

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
