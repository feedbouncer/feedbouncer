import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from '../site.config.ts';

const HERE = new URL('.', import.meta.url);

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

/**
 * The lock after `--update`: every locked route stays and new built routes are added. A route is
 * never dropped here, so removing a page needs a redirect (or a deliberate edit of the lock).
 */
export function mergeLock(lock, built) {
  return [...new Set([...lock, ...built])].sort();
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
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  if (process.argv.includes('--update')) {
    const merged = mergeLock(lock, built);
    writeLock(lockFile, merged, merged.length - lock.length);
    return;
  }
  const { missing, unlocked } = checkRoutes(built, lock, redirects);
  if (missing.length) {
    console.error(
      `Locked routes that no longer exist and have no redirect:\n  ${missing.join('\n  ')}\n` +
        'Fix: add a redirect in apps/docs/redirects.json. routes:update never removes a locked route;\n' +
        'drop one from routes.lock.json by hand only when the removal is deliberate.',
    );
  }
  if (unlocked.length) {
    console.error(
      `Built routes missing from routes.lock.json:\n  ${unlocked.join('\n  ')}\n` +
        'Fix: run pnpm --filter @feedbouncer/docs routes:update (it only adds routes).',
    );
  }
  if (missing.length || unlocked.length) process.exit(1);
  console.log(`routes ok (${built.length} built, ${lock.length} locked)`);
}

function writeLock(file, routes, added) {
  writeFileSync(file, `${JSON.stringify(routes, null, 2)}\n`);
  console.log(`routes.lock.json: ${added} added, ${routes.length} locked`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
