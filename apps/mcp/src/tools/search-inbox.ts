import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { runTool, type ToolDeps } from './common.js';
import { inboxFilters, inboxPage } from './list-inbox.js';

const input = inboxFilters.extend({
  query: z.string().trim().min(2).max(200).describe('Words to search for in comment text.'),
});

export function registerSearchInbox(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'search_inbox',
    {
      title: 'Search inbox',
      description:
        'Read-only. Searches comment text in the FeedBouncer inbox, with the same filters and paging as list_inbox.',
      inputSchema: input,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, ...filters }) =>
      runTool(deps, 'search_inbox', filters.brandId, () =>
        inboxPage(deps, { ...filters, q: query }),
      ),
  );
}
