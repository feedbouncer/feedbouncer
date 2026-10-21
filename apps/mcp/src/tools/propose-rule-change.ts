import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { ProposalSchema, type RuleChangeBody } from '../api-client.js';
import { idempotencyKey, runTool, text, type ToolDeps } from './common.js';

const MAX_JSON_CHARS = 16_384;
const fields = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= MAX_JSON_CHARS, {
    message: `must be at most ${MAX_JSON_CHARS} characters as JSON`,
  });

/** The fields each operation takes; any other operation field is rejected. */
const FIELDS = {
  create: ['rule'],
  update: ['ruleId', 'patch'],
  archive: ['ruleId'],
} as const;
const OPERATION_FIELDS = ['rule', 'ruleId', 'patch'] as const;

const input = z
  .object({
    brandId: z.uuid(),
    operation: z.enum(['create', 'update', 'archive']),
    rule: fields.optional().describe('create only: the new rule.'),
    ruleId: z.uuid().optional().describe('update and archive only: the rule to change.'),
    patch: fields.optional().describe('update only: the rule fields to change.'),
    rationale: z
      .string()
      .max(1000)
      .optional()
      .describe('Why the change is needed, for the reviewer.'),
    idempotencyKey,
  })
  .superRefine((v, ctx) => {
    const wanted: readonly string[] = FIELDS[v.operation];
    for (const f of OPERATION_FIELDS) {
      const present = v[f] !== undefined;
      if (present !== wanted.includes(f)) {
        ctx.addIssue({
          code: 'custom',
          path: [f],
          message: `${f} is ${present ? 'not allowed' : 'required'} for ${v.operation}`,
        });
      }
    }
  });

function toBody({ brandId, operation, rationale, ...v }: z.output<typeof input>): RuleChangeBody {
  const base = { brandId, ...(rationale !== undefined && { rationale }) };
  // The schema refinement guarantees the fields each operation needs.
  switch (operation) {
    case 'create':
      return { operation, ...base, rule: v.rule! };
    case 'update':
      return { operation, ...base, ruleId: v.ruleId!, patch: v.patch! };
    case 'archive':
      return { operation, ...base, ruleId: v.ruleId! };
  }
}

const output = z.object({
  proposalId: ProposalSchema.shape.id,
  status: ProposalSchema.shape.status,
  diff: ProposalSchema.shape.diff,
  warnings: ProposalSchema.shape.warnings,
  expiresAt: ProposalSchema.shape.expiresAt,
  reviewUrl: ProposalSchema.shape.reviewUrl,
});

export function registerProposeRuleChange(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'propose_rule_change',
    {
      title: 'Propose rule change',
      description:
        'Creates a pending proposal to create, update or archive a moderation rule; no rule changes until a person approves it in the FeedBouncer web app.',
      inputSchema: input,
      outputSchema: output,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
