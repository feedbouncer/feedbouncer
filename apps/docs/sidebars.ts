import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';
import apiSidebar from './docs/api/reference/sidebar';

// `docusaurus gen-api-docs` writes this sidebar; scripts/prepare-content.mjs stands in an empty one before it runs.
const apiReference = apiSidebar.apisidebar;
if (!Array.isArray(apiReference))
  throw new Error('The generated API sidebar is not a list of items.');

const sidebars: SidebarsConfig = {
  docs: [
    { type: 'category', label: 'Concepts', items: ['concepts/overview'] },
    { type: 'category', label: 'Rules', items: ['rules/overview'] },
    { type: 'category', label: 'API reference', items: ['api/overview', ...apiReference] },
    { type: 'category', label: 'MCP setup', items: ['mcp/overview'] },
  ],
};

export default sidebars;
