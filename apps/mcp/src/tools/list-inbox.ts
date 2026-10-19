import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ListQuery } from '../api-client.js';
import { UNTRUSTED_NOTICE, formatComment, framedComment } from '../present.js';
import { runTool, text, timestamp, type Outcome, type ToolDeps } from './common.js';

export const inboxFilters = z.object({
  brandId: z.uuid().optional().describe('Only comments for this brand.'),
  status: z.enum(['visible', 'hidden', 'replied', 'unanswered', 'flagged']).optional(),
  platform: z.enum(['facebook', 'instagram']).optional(),
  from: timestamp.optional().describe('Posted at or after this ISO 8601 time (with offset).'),
  to: timestamp.optional().describe('Posted before this ISO 8601 time (with offset).'),
  limit: z.int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional().describe('nextCursor from a previous page.'),
});

type InboxArgs = z.output<typeof inboxFilters> & { q?: string };

export async function inboxPage(deps: ToolDeps, args: InboxArgs): Promise<Outcome> {
  const { from, to, ...rest } = args;
  const query: ListQuery = { ...rest, postedFrom: from, postedTo: to };
  const page = await deps.api.listComments(query);
  // Some clients pass structuredContent to the model, so public text is framed there too.
  const structuredContent = {
    comments: page.data.map(framedComment),
    nextCursor: page.nextCursor,
  };
  if (page.data.length === 0) {
    return { result: { content: text('No comments match.'), structuredContent }, outcome: 'ok' };
  }
  const content = text(
    UNTRUSTED_NOTICE,
    ...page.data.map(formatComment),
    page.nextCursor === null ? 'No more pages.' : `nextCursor: ${page.nextCursor}`,
  );
  return { result: { content, structuredContent }, outcome: 'ok' };
}

export function registerListInbox(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_inbox',
    {
      title: 'List inbox',
      description:
        'Read-only. Lists comments from the FeedBouncer inbox, filtered by brand, status, platform and posting time; page with nextCursor.',
      inputSchema: inboxFilters,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(deps, 'list_inbox', args.brandId, () => inboxPage(deps, args)),
  );
}
