// Keeps the n8n node PRs from changing product behaviour: a change set that touches
// the n8n package must not also touch apps/, packages/ or the API description.
// Reads changed paths (one per line) on stdin; exits 1 with a message on violation.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const NODE_PACKAGE = 'integrations/n8n-nodes-feedbouncer/';
const isProductPath = (p) => p.startsWith('apps/') || p.startsWith('packages/') || p === 'docs/api/openapi.json';

export function productPathsWithNodeChange(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  return files.some((p) => p.startsWith(NODE_PACKAGE)) ? files.filter(isProductPath) : [];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const offending = productPathsWithNodeChange(readFileSync(0, 'utf8').split('\n'));
  if (offending.length > 0) {
    console.error(
      `This PR changes ${NODE_PACKAGE} and also product code or the API description.\n` +
        `The n8n node must not change API behaviour; split the PR. Offending paths:\n` +
        offending.map((p) => `  ${p}`).join('\n'),
    );
    process.exit(1);
  }
}
