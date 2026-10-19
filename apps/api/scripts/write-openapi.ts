import { mkdirSync, writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/public-api/openapi.js';

const file = new URL('../../../docs/api/openapi.json', import.meta.url);
mkdirSync(new URL('.', file), { recursive: true });
writeFileSync(file, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
