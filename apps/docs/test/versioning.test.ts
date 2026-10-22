import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../docusaurus.config';
import { ensureApiSidebar, prepareContent } from '../scripts/prepare-content.mjs';
import { stampDir } from '../scripts/stamp-generated.mjs';

const appRoot = resolve(fileURLToPath(import.meta.url), '../..');
const repoRoot = resolve(appRoot, '../..');

describe('versioning', () => {
  it('versions.json, if present, lists X.Y.Z names, each with a versioned_docs dir and sidebar', () => {
    const file = join(appRoot, 'versions.json');
    if (!existsSync(file)) return;
    const versions = JSON.parse(readFileSync(file, 'utf8')) as string[];
    for (const name of versions) {
      expect(name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(existsSync(join(appRoot, `versioned_docs/version-${name}`))).toBe(true);
      expect(existsSync(join(appRoot, `versioned_sidebars/version-${name}-sidebars.json`))).toBe(
        true,
      );
    }
  });

  it('current is labelled main (unreleased) with the unreleased banner', () => {
    const preset = config.presets![0] as [string, { docs: { versions: { current: unknown } } }];
    expect(preset[1].docs.versions.current).toMatchObject({
      label: 'main (unreleased)',
      banner: 'unreleased',
      badge: true,
    });
  });

  it('versioned snapshots are byte-stable when prepare-content and the stamp run', () => {
    // Everything happens in a scratch copy of the app layout; the real tree is never touched.
    const scratch = mkdtempSync(join(tmpdir(), 'docs-stamp-'));
    try {
      const repo = join(scratch, 'repo');
      const app = join(repo, 'apps/docs');
      const docsDir = join(app, 'docs');
      for (const rel of [
        'docs/api/openapi.json',
        'docs/mcp/tools.json',
        'docs/reference/product-reference.json',
      ]) {
        mkdirSync(dirname(join(repo, rel)), { recursive: true });
        copyFileSync(join(repoRoot, rel), join(repo, rel));
      }
      const snapshot = join(app, 'versioned_docs/version-0.0.0-test');
      mkdirSync(join(snapshot, 'api/reference'), { recursive: true });
      mkdirSync(join(snapshot, '_generated'), { recursive: true });
      writeFileSync(join(snapshot, 'intro.md'), '---\ntitle: Frozen\n---\n\nSnapshot body.\n');
      writeFileSync(join(snapshot, '_generated/tools.json'), '{"tools":[]}\n');
      writeFileSync(
        join(snapshot, 'api/reference/op.api.mdx'),
        '---\nlast_update:\n  date: 2000-01-01T00:00:00+00:00\n---\n\nFrozen operation.\n',
      );
      mkdirSync(join(docsDir, 'api/reference'), { recursive: true });
      const live = join(docsDir, 'api/reference/op.api.mdx');
      writeFileSync(live, '---\ntitle: Live\n---\n\nLive operation.\n');

      const hashes = () =>
        Object.fromEntries(
          readdirSync(snapshot, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => join(e.parentPath, e.name))
            .sort()
            .map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]),
        );
      const before = hashes();
      expect(Object.keys(before)).toHaveLength(3);

      prepareContent(repo, docsDir);
      ensureApiSidebar(docsDir);
      expect(stampDir(join(docsDir, 'api/reference'), '2026-01-01T00:00:00+00:00')).toBe(1);

      // The run did its work on the live tree ...
      expect(readFileSync(live, 'utf8')).toContain('date: 2026-01-01T00:00:00+00:00');
      expect(existsSync(join(docsDir, '_generated/tools.json'))).toBe(true);
      // ... and left every snapshot file byte for byte alone.
      expect(hashes()).toEqual(before);
      expect(() => stampDir(join(snapshot, 'api/reference'), '2026-01-01T00:00:00+00:00')).toThrow(
        /frozen/,
      );
      expect(hashes()).toEqual(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
