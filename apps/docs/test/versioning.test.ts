import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../docusaurus.config';
import { ensureApiSidebar, prepareContent } from '../scripts/prepare-content.mjs';
import { stampLastUpdate } from '../scripts/stamp-generated.mjs';

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

  it('versioned snapshot is byte-stable across builds', () => {
    const docsDir = join(appRoot, 'docs');
    const versionedRoot = join(appRoot, 'versioned_docs');
    const fixtureDir = join(versionedRoot, 'version-0.0.0-test');
    const sidebar = join(docsDir, 'api/reference/sidebar.ts');
    const generated = join(docsDir, '_generated');
    // Remember what already existed so only this test's own files are removed afterwards.
    const hadVersionedRoot = existsSync(versionedRoot);
    const hadSidebar = existsSync(sidebar);
    const hadGenerated = existsSync(generated);
    const scratch = mkdtempSync(join(tmpdir(), 'docs-stamp-'));
    try {
      mkdirSync(join(fixtureDir, 'api/reference'), { recursive: true });
      writeFileSync(join(fixtureDir, 'intro.md'), '---\ntitle: Frozen\n---\n\nSnapshot body.\n');
      writeFileSync(
        join(fixtureDir, 'api/reference/op.api.mdx'),
        '---\nlast_update:\n  date: 2000-01-01T00:00:00+00:00\n---\n\nFrozen operation.\n',
      );
      const hashes = () =>
        Object.fromEntries(
          readdirSync(fixtureDir, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => join(e.parentPath, e.name))
            .sort()
            .map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]),
        );
      const before = hashes();
      expect(Object.keys(before)).toHaveLength(2);

      prepareContent(repoRoot, docsDir);
      ensureApiSidebar(docsDir);
      const page = join(scratch, 'page.mdx');
      writeFileSync(page, '---\ntitle: Generated\n---\n\nBody\n');
      stampLastUpdate(page, '2026-01-01T00:00:00+00:00');

      expect(hashes()).toEqual(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
      if (!hadVersionedRoot) rmSync(versionedRoot, { recursive: true, force: true });
      if (!hadSidebar) rmSync(sidebar, { force: true });
      if (!hadGenerated) rmSync(generated, { recursive: true, force: true });
    }
  });
});
