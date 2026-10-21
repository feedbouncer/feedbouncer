import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { RulesSchema, type RulesResponse } from '../api-client.js';
import { runTool, text, type ToolDeps } from './common.js';

const input = z.object({ brandId: z.uuid().optional().describe('Only rules for this brand.') });

function renderBrand(b: RulesResponse['brands'][number]): string {
  const rules = b.rules.map(
    (r) =>
      `- ${r.name} [${r.id}] mode: ${r.mode}, priority: ${r.priority}, ${r.enabled ? 'enabled' : 'disabled'}\n` +
      `  conditions: ${JSON.stringify(r.conditions)}\n  actions: ${JSON.stringify(r.actions)}`,
  );
  const changes = b.changes.map(
    (c) =>
      `- ${c.id}: ${c.operation} ${c.ruleId ?? '(new rule)'} ${c.status}, expires ${c.expiresAt}`,
  );
  return [
    `Brand ${b.name} [${b.id}], rule revision ${b.ruleRevision}`,
    'Rules:',
    ...(rules.length > 0 ? rules : ['- none']),
    'Change proposals:',
    ...(changes.length > 0 ? changes : ['- none']),
  ].join('\n');
}

export function registerReadRules(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'read_rules',
    {
      title: 'Read rules',
      description:
        'Read-only. Lists the moderation rules of each brand and the status of recent rule-change proposals.',
      inputSchema: input,
      outputSchema: RulesSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      runTool(deps, 'read_rules', args.brandId, async () => {
        const res = await deps.api.rules(args.brandId);
        const content =
          res.brands.length > 0 ? text(...res.brands.map(renderBrand)) : text('No brands found.');
        return { result: { content, structuredContent: res }, outcome: 'ok' };
      }),
  );
}
