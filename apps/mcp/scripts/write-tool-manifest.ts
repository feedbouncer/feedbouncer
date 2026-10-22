import { mkdirSync, writeFileSync } from 'node:fs';
import { buildToolManifest } from '../src/testing/tool-manifest.js';

const file = new URL('../../../docs/mcp/tools.json', import.meta.url);
mkdirSync(new URL('.', file), { recursive: true });
writeFileSync(file, `${JSON.stringify(await buildToolManifest(), null, 2)}\n`);
