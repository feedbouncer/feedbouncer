import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { RuleChangeBody } from '../api-client.js';
import { idempotencyKey, runTool, text, type ToolDeps } from './common.js';

const fields = z.record(z.string(), z.unknown());

const input = z.object({
  brandId: z.uuid(),
  operation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), rule: fields.describe('The new rule.') }),
    z.object({
      kind: z.literal('update'),
      ruleId: z.uuid(),
      patch: fields.describe('Rule fields to change.'),
    }),
    z.object({ kind: z.literal('archive'), ruleId: z.uuid() }),
  ]),
  rationale: z
    .string()
    .max(1000)
    .optional()
    .describe('Why the change is needed, for the reviewer.'),
  idempotencyKey,
});

function toBody({ brandId, operation, rationale }: z.output<typeof input>): RuleChangeBody {
  const base = { brandId, ...(rationale !== undefined && { rationale }) };
  switch (operation.kind) {
    case 'create':
      return { operation: 'create', ...base, rule: operation.rule };
    case 'update':
      return { operation: 'update', ...base, ruleId: operation.ruleId, patch: operation.patch };
    case 'archive':
      return { operation: 'archive', ...base, ruleId: operation.ruleId };
  }
}

export function registerProposeRuleChange(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'propose_rule_change',
    {
      title: 'Propose rule change',
      description:
        'Creates a pending proposal to create, update or archive a moderation rule; no rule changes until a person approves it in the FeedBouncer web app.',
      inputSchema: input,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) =>
      runTool(deps, 'propose_rule_change', args.brandId, async () => {
        const p = await deps.api.proposeRuleChange(
          toBody(args),
          args.idempotencyKey ?? randomUUID(),
        );
        const lines = [
          `Pending — no rules changed. A person must approve it at ${p.reviewUrl} before ${p.expiresAt}.`,
          ...p.warnings.map((w) => `Warning: ${w}`),
        ];
        return {
          result: {
            content: text(lines.join('\n')),
            structuredContent: {
              proposalId: p.id,
              status: p.status,
              diff: p.diff,
              warnings: p.warnings,
              expiresAt: p.expiresAt,
              reviewUrl: p.reviewUrl,
            },
          },
          outcome: p.status,
        };
      }),
  );
}
