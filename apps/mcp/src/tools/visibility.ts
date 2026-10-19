import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { actionError, idempotencyKey, runTool, text, type ToolDeps } from './common.js';

const input = z.object({
  commentId: z.uuid().describe('ID of the comment (from list_inbox).'),
  visibility: z.enum(['hidden', 'visible']),
  idempotencyKey,
});

export function registerVisibility(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'set_comment_visibility',
    {
      title: 'Hide or unhide comment',
      description:
        'Hides a comment from the public or makes a hidden comment visible again. Acts on the live social platform. Nothing is deleted.',
      inputSchema: input,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) =>
      runTool(deps, 'set_comment_visibility', args.commentId, async () => {
        const { action, comment } = await deps.api.setVisibility(
          args.commentId,
          args.visibility,
          args.idempotencyKey ?? randomUUID(),
        );
        switch (action.status) {
          case 'noop':
            return {
              result: {
                content: text(`Already ${args.visibility} — nothing changed.`),
                structuredContent: { changed: false, reason: action.code ?? 'noop' },
              },
              outcome: 'noop',
            };
          case 'applied':
          case 'pending':
            return {
              result: {
                content: text(
                  action.status === 'applied'
                    ? `Comment is now ${args.visibility}.`
                    : `Change to ${args.visibility} is queued (action ${action.id}).`,
                ),
                structuredContent: { changed: true, status: action.status },
              },
              outcome: action.status,
            };
          default: {
            const { result, code } = actionError(action, comment.platform);
            return { result, outcome: code };
          }
        }
      }),
  );
}
