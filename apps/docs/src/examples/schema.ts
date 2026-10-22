import { z } from 'zod';
import { STEP_TYPES } from '@feedbouncer/actions';
import { ruleInputSchema } from '@feedbouncer/rules';

export const workedExampleSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  case: z.union([z.enum(['spam_links', 'repeated_comments', 'abusive_language']), z.string()]),
  rules: z.array(ruleInputSchema.extend({ priority: z.number().int() })),
  brand: z.strictObject({ ownDomains: z.array(z.string()) }),
  comment: z.strictObject({
    text: z.string(),
    authorHandle: z.string().optional(),
    authorExternalId: z.string().optional(),
    mild: z.boolean().optional(),
  }),
  expected: z.strictObject({
    decidedRule: z.string().nullable(),
    outcome: z.enum(['approve', 'flag', 'hide', 'remove', 'none']),
    steps: z.array(z.enum(STEP_TYPES)),
    suggestions: z.array(z.string()),
    alsoMatched: z.array(z.string()),
  }),
  note: z.string().optional(),
});

export type WorkedExampleData = z.output<typeof workedExampleSchema>;
