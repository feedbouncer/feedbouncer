import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const stub = (name: string) => fileURLToPath(new URL(`./test/stubs/${name}.tsx`, import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  // Docusaurus resolves these virtual modules at build time; tests use plain stand-ins.
  resolve: { alias: { '@docusaurus/Link': stub('Link'), '@theme/CodeBlock': stub('CodeBlock') } },
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
