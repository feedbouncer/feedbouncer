import { z } from 'zod';
import { ITEM_ID_RE, LABELLER_RE, LABEL_CATEGORIES, RUN_SCHEMA_VERSION } from './constants.js';

const nonNegInt = z.number().int().nonnegative();
const finiteNonNeg = z.number().finite().nonnegative();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const modelId = z.string().min(1).max(200);

export const LabelCategory = z.enum(LABEL_CATEGORIES);
export type LabelCategory = z.infer<typeof LabelCategory>;

const DECIDER_RE =
  /^(rule:[a-z_]+|classifier:[a-z_]+|classifier|policy|system|suggestion:(rule|classifier|policy))$/;

export const EvalItem = z.strictObject({
  item: z.string().regex(ITEM_ID_RE),
  cohort: z.enum(['automatic', 'review']),
  channel: z.enum(['webhook', 'poll', 'backfill']),
  platform: z.enum(['facebook', 'instagram']),
  language: z.string().regex(/^([a-z]{2,3}|und)$/),
  judgedVersionAvailable: z.boolean(),
  ruleDecided: z.boolean(),
  outcome: z.enum(['hidden', 'not_hidden', 'hide_failed']),
  removalKind: z.enum(['hide', 'delete']).nullable(),
  removalNoop: z.boolean(),
  restored: z.boolean(),
  selfReversed: z.boolean(),
  decider: z.string().regex(DECIDER_RE).nullable(),
  caughtByDecision: z.boolean(),
  review: z
    .strictObject({
      suggestionStatus: z.string().min(1).max(64),
      humanWaitMs: z.number().finite().nullable(),
    })
    .nullable(),
  timing: z
    .strictObject({
      totalMs: z.number().finite(),
      retried: z.boolean(),
      breakdown: z
        .strictObject({
          deliveryMs: z.number().finite(),
          ingestQueueMs: z.number().finite(),
          processingMs: z.number().finite(),
          hideQueueMs: z.number().finite(),
          hideCallMs: z.number().finite(),
        })
        .nullable(),
    })
    .nullable(),
  modelCalls: z.array(
    z.strictObject({
      stage: z.enum(['classifier', 'policy']),
      model: modelId,
      inputTokens: nonNegInt.nullable(),
      outputTokens: nonNegInt.nullable(),
      cacheReadTokens: nonNegInt.nullable(),
    }),
  ),
});
export type EvalItem = z.infer<typeof EvalItem>;

export const RunManifest = z.strictObject({
  runSchemaVersion: z.literal(RUN_SCHEMA_VERSION),
  exportedAt: z.string(),
  window: z.strictObject({ from: z.string(), to: z.string() }),
  brandsScoped: z.boolean(),
  itemCount: nonNegInt,
  labelSheetCount: nonNegInt,
  sample: z.strictObject({ size: nonNegInt, seed: z.number().int() }).nullable(),
  excludedAuthorDeleted: nonNegInt,
  timingUnavailableBeforeRetention: nonNegInt,
  bytesPerComment: finiteNonNeg.nullable(),
  promptVersions: z.array(z.string()),
  jobRetentionDays: nonNegInt,
});
export type RunManifest = z.infer<typeof RunManifest>;

// Extra CSV columns are ignored, so this is a plain (non-strict) object.
export const LabelRow = z.object({
  item: z.string().regex(ITEM_ID_RE),
  labeller: z.string().regex(LABELLER_RE),
  verdict: z.enum(['should_hide', 'should_stay']),
  category: LabelCategory.optional(),
  role: z.enum(['labeller', 'adjudicator']).optional(),
});
export type LabelRow = z.infer<typeof LabelRow>;

export const MetaRow = z.object({
  item: z.string().regex(ITEM_ID_RE),
  meta_outcome: z.enum(['hidden', 'visible', 'not_compared']),
  note: z.string().max(200).optional(),
});
export type MetaRow = z.infer<typeof MetaRow>;

export const MetaConfig = z.strictObject({
  observedOn: dateOnly,
  page: z
    .string()
    .max(200)
    .refine((s) => !/http/i.test(s), 'page is a description, not a URL'),
  profanityFilter: z.enum(['off', 'medium', 'strong']),
  blockedKeywords: z.array(z.string().max(100)).max(500),
  method: z.string().max(2000),
  notCompared: z.array(z.string().max(300)).max(20),
});
export type MetaConfig = z.infer<typeof MetaConfig>;

export const Pricing = z.strictObject({
  pricedAt: dateOnly,
  currency: z.literal('USD'),
  models: z.record(
    modelId,
    z.strictObject({
      inputPerMTok: finiteNonNeg,
      outputPerMTok: finiteNonNeg,
      cacheReadPerMTok: finiteNonNeg.optional(),
      note: z.string().optional(),
    }),
  ),
  compute: z.strictObject({
    usdPerMonth: finiteNonNeg,
    commentsPerMonth: z.number().finite().positive(),
    note: z.string().optional(),
  }),
  storage: z.strictObject({ usdPerGbMonth: finiteNonNeg, retentionMonths: finiteNonNeg }),
  other: z.array(
    z.strictObject({ name: z.string(), usdPer1000: finiteNonNeg, note: z.string().optional() }),
  ),
});
export type Pricing = z.infer<typeof Pricing>;
