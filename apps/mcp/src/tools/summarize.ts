import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { SummarySchema, type Summary } from '../api-client.js';
import { UNTRUSTED_NOTICE, wrapUntrusted } from '../present.js';
import { runTool, text, timestamp, type ToolDeps } from './common.js';

const input = z.object({
  from: timestamp.optional().describe('Start of the period (ISO 8601 with offset).'),
  to: timestamp.optional().describe('End of the period (ISO 8601 with offset).'),
  brandId: z.uuid().optional(),
});

function render(s: Summary): string[] {
  const { comments, hidden, replied, unanswered } = s.totals;
  const lines = [
    `Period: ${s.period.from} to ${s.period.to}`,
    ...(s.bounded
      ? [
          `Range was limited to the last 92 days of the requested period (requested from ${s.bounded.requestedFrom}).`,
        ]
      : []),
    `Comments: ${comments}, hidden: ${hidden}, replied: ${replied}, unanswered: ${unanswered}`,
    `Categories: ${s.categories.map((c) => `${c.category} ${c.count}`).join(', ') || 'none'}`,
    `Top rules: ${s.topRules.map((r) => `${r.name} [${r.ruleId}] ${r.matches}`).join(', ') || 'none'}`,
  ];
  if (s.notableThreads.length === 0) return [lines.join('\n')];
  const threads = s.notableThreads.map((t) =>
    [
      `id: ${t.commentId} | platform: ${t.platform} | replies: ${t.replies} | posted: ${t.postedAt}`,
      ...(t.authorName === null
        ? []
        : [`author: ${wrapUntrusted('author', t.commentId, t.authorName)}`]),
      wrapUntrusted('comment', t.commentId, t.textPreview),
    ].join('\n'),
  );
  return [lines.join('\n'), UNTRUSTED_NOTICE, 'Notable threads:', ...threads];
}

/** Some clients pass structuredContent to the model, so public text is framed there too. */
function framed(s: Summary): Summary {
  return {
    ...s,
    notableThreads: s.notableThreads.map((t) => ({
      ...t,
      authorName: t.authorName === null ? null : wrapUntrusted('author', t.commentId, t.authorName),
      textPreview: wrapUntrusted('comment', t.commentId, t.textPreview),
    })),
  };
}

export function registerSummarize(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'summarize_period',
    {
      title: 'Summarize period',
      description:
        'Read-only. Summarizes comment activity for a period (at most 92 days): totals, categories, top matching rules and notable threads.',
      inputSchema: input,
      outputSchema: SummarySchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool(deps, 'summarize_period', args.brandId, async () => {
        const summary = await deps.api.summary(args);
        return {
          result: { content: text(...render(summary)), structuredContent: framed(summary) },
          outcome: summary.bounded ? 'bounded' : 'ok',
        };
      }),
  );
}
