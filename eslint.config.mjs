import baseConfig from './eslint.config.base.mjs';

// Node globals used by the .mjs tooling under scripts/ (no `globals` package needed).
const nodeGlobals = Object.fromEntries(
  ['console', 'process', 'fetch', 'AbortSignal', 'setTimeout', 'clearTimeout', 'URL'].map((n) => [
    n,
    'readonly',
  ]),
);

export default [
  ...baseConfig,
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: nodeGlobals } },
  { ignores: ['apps/**', 'packages/**'] },
];
