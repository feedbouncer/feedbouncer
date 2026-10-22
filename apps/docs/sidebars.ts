import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';
import apiReference from './docs/api/reference/sidebar';

// `docusaurus gen-api-docs` writes this sidebar; scripts/prepare-content.mjs stands in an empty one before it runs.
if (!Array.isArray(apiReference))
  throw new Error('The generated API sidebar is not a list of items.');

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Concepts',
      items: [
        'concepts/overview',
        'concepts/comment-lifecycle',
        'concepts/organizations-brands-connections',
        'concepts/decisions-and-audit',
        'concepts/review-mode',
        'concepts/ai-classifier-and-policies',
        'concepts/self-hosting',
        'concepts/glossary',
      ],
    },
    {
      type: 'category',
      label: 'Rules',
      items: [
        'rules/overview',
        'rules/conditions',
        'rules/actions',
        'rules/precedence',
        'rules/testing-and-changing-rules',
        'rules/examples',
        'rules/limits',
      ],
    },
    {
      type: 'category',
      label: 'API reference',
      items: [
        'api/overview',
        'api/quickstart',
        'api/authentication',
        'api/errors',
        'api/pagination',
        'api/rate-limits',
        'api/idempotency',
        'api/webhooks',
        'api/moderation-check',
        ...apiReference,
      ],
    },
    {
      type: 'category',
      label: 'MCP setup',
      items: [
        'mcp/overview',
        'mcp/prerequisites',
        'mcp/authentication',
        {
          type: 'category',
          label: 'Clients',
          items: [
            'mcp/clients/claude-desktop',
            'mcp/clients/claude-code',
            'mcp/clients/cursor',
            'mcp/clients/vscode',
            'mcp/clients/generic',
          ],
        },
        'mcp/verify',
        'mcp/tools',
        'mcp/approvals',
        'mcp/troubleshooting',
      ],
    },
  ],
};

export default sidebars;
