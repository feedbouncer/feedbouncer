import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROADMAP_ROUTE, ROADMAP_URL } from '../site.config';
import { repoRoot } from './lib/content';

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

describe('roadmap links', () => {
  it('README links the rendered roadmap URL, never the source file', () => {
    expect(readme).toContain(`](${ROADMAP_URL})`);
    expect(readme).not.toMatch(/\]\((\.\/)?apps\/docs\/src\/pages\/roadmap\.md\)/);
    expect(readme).not.toMatch(/raw\.githubusercontent\.com|\/raw\/main\//);
  });

  it('footer links /roadmap/ by client route', async () => {
    const { default: config } = await import('../docusaurus.config');
    const items = (config.themeConfig as any).footer.links.flatMap((c: any) => c.items);
    expect(items).toContainEqual({ label: 'Roadmap', to: ROADMAP_ROUTE });
  });

  it('CONTRIBUTING tells contributors to bump Last updated', () => {
    const s = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8')
      .split('\n## Updating the roadmap\n')[1]!
      .split('\n## ')[0]!;
    expect(s).toMatch(/Last updated/);
    expect(s).toMatch(/same pull request/);
    expect(s).toContain(ROADMAP_URL);
  });
});
