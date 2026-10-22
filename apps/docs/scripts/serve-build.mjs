import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { BASE_URL } from '../site.config.ts';

const ROOT = join(import.meta.dirname, '..', 'build');
const [, , port = '3210', host = '127.0.0.1'] = process.argv;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Static server for the built site that behaves like GitHub Pages: a query string never
 * changes how a file is found. (`docusaurus serve` redirects `file.json?ts=1` to `file.json/`,
 * which breaks the search index requests that Pagefind makes with a cache-busting query.)
 */
function resolveFile(pathname) {
  const target = normalize(join(ROOT, pathname.slice(BASE_URL.length)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  if (existsSync(target) && statSync(target).isFile()) return target;
  const index = join(target, 'index.html');
  return existsSync(index) ? index : null;
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (!pathname.startsWith(BASE_URL)) {
    res.writeHead(302, { Location: BASE_URL }).end();
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = resolveFile(decoded);
  const served = file ?? join(ROOT, '404.html');
  res.writeHead(file ? 200 : 404, {
    'Content-Type': TYPES[extname(served)] ?? 'application/octet-stream',
  });
  createReadStream(served).pipe(res);
}).listen(Number(port), host, () =>
  console.log(`Serving ${ROOT} at http://${host}:${port}${BASE_URL}`),
);
