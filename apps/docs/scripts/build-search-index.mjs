import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import * as pagefind from 'pagefind';
import { versionForPath } from '../src/search/core.ts';
import { BASE_URL } from '../site.config.ts';

const ROOT = join(import.meta.dirname, '..');

function loadVersions() {
  const file = join(ROOT, 'versions.json');
  const released = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  if (released.length === 0) return [{ name: 'current', path: '' }];
  return [
    { name: 'current', path: 'next' },
    ...released.map((name, i) => ({ name, path: i === 0 ? '' : name })),
  ];
}

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name === 'index.html') yield path;
  }
}

function docRoutesInSitemap(sitemap) {
  return [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].filter(([, loc]) =>
    new URL(loc).pathname.startsWith(`${BASE_URL}docs/`),
  ).length;
}

async function main() {
  const build = join(ROOT, 'build');
  const versions = loadVersions();
  const { index, errors: createErrors } = await pagefind.createIndex({});
  const errors = [...createErrors];
  let indexed = 0;

  for (const file of htmlFiles(join(build, 'docs'))) {
    const route = `${BASE_URL}${relative(build, file).split(sep).slice(0, -1).join('/')}/`;
    const content = readFileSync(file, 'utf8').replace(
      '<article',
      `<article data-pagefind-body data-pagefind-filter="version:${versionForPath(route, versions)}"`,
    );
    const result = await index.addHTMLFile({ url: route, content });
    errors.push(...result.errors);
    if (result.file) indexed += 1;
  }

  const written = await index.writeFiles({ outputPath: join(build, 'pagefind') });
  errors.push(...written.errors);
  await pagefind.close();

  const expected = docRoutesInSitemap(readFileSync(join(build, 'sitemap.xml'), 'utf8'));
  if (errors.length > 0 || indexed < expected) {
    console.error(`Search index failed: ${indexed}/${expected} pages indexed.`, ...errors);
    process.exit(1);
  }
  console.log(`Search index: ${indexed} pages indexed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
