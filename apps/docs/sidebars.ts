import { existsSync } from 'node:fs';
import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// The API reference sidebar is produced by `docusaurus gen-api-docs`; it is absent until then.
const apiReference =
  existsSync(new URL('./docs/api/reference/sidebar.ts', import.meta.url)) ||
  existsSync(new URL('./docs/api/reference/sidebar.js', import.meta.url))
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('./docs/api/reference/sidebar') as { default?: unknown[] } | unknown[])
    : [];

const sidebars: SidebarsConfig = {
  docs: [
    { type: 'category', label: 'Concepts', items: ['concepts/overview'] },
    { type: 'category', label: 'Rules', items: ['rules/overview'] },
    {
      type: 'category',
      label: 'API reference',
      items: [
        'api/overview',
        ...((Array.isArray(apiReference) ? apiReference : apiReference.default) ?? []),
      ] as never,
    },
    { type: 'category', label: 'MCP setup', items: ['mcp/overview'] },
  ],
};

export default sidebars;
