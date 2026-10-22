import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = new URL('.', import.meta.url);
const BASE_URL = '/feedbouncer/';

/**
 * Compare the built routes with the committed route lock.
 * `missing`: locked routes that are neither built nor the `from` of a redirect.
 * `unlocked`: built routes that are not in the lock yet.
 */
export function checkRoutes(built, lock, redirects) {
  const builtSet = new Set(built);
  const lockSet = new Set(lock);
  const redirected = new Set(redirects.flatMap((r) => (Array.isArray(r.from) ? r.from : [r.from])));
  return {
    missing: lock.filter((route) => !builtSet.has(route) && !redirected.has(route)).sort(),
    unlocked: built.filter((route) => !lockSet.has(route)).sort(),
  };
}

/** Routes in build/sitemap.xml, with the base URL stripped and a leading slash kept. */
export function readBuiltRoutes(sitemapPath) {
  const xml = readFileSync(sitemapPath, 'utf8');
  const routes = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => {
    const path = new URL(loc).pathname;
    return path.startsWith(BASE_URL) ? `/${path.slice(BASE_URL.length)}` : path;
  });
  return [...new Set(routes)].sort();
}

function main() {
  const sitemap = fileURLToPath(new URL('../build/sitemap.xml', HERE));
  const lockFile = fileURLToPath(new URL('../routes.lock.json', HERE));
  const redirects = JSON.parse(
    readFileSync(fileURLToPath(new URL('../redirects.json', HERE)), 'utf8'),
  );
  if (!existsSync(sitemap)) {
    console.error('build/sitemap.xml is missing: run the docs build first.');
    process.exit(1);
  }
  const built = readBuiltRoutes(sitemap);
  if (process.argv.includes('--update')) {
    writeLock(lockFile, built);
    return;
  }
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  const { missing, unlocked } = checkRoutes(built, lock, redirects);
  if (missing.length) {
    console.error(
      `Locked routes that no longer exist and have no redirect:\n  ${missing.join('\n  ')}\n` +
        'Fix: add a redirect in apps/docs/redirects.json.',
    );
  }
  if (unlocked.length) {
    console.error(
      `Built routes missing from routes.lock.json:\n  ${unlocked.join('\n  ')}\n` +
        'Fix: run pnpm --filter @feedbouncer/docs routes:update.',
    );
  }
  if (missing.length || unlocked.length) process.exit(1);
  console.log(`routes ok (${built.length} built, ${lock.length} locked)`);
}

import { writeFileSync } from 'node:fs';
function writeLock(file, routes) {
  writeFileSync(file, `${JSON.stringify(routes, null, 2)}\n`);
  console.log(`wrote ${routes.length} routes to routes.lock.json`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
