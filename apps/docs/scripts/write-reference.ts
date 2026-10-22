import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { STEP_META, STEP_TYPES, CONFLICTS, type StepType } from '@feedbouncer/actions';
import { REASON_CODES } from '@feedbouncer/moderation-contract';
import {
  API_KEY_SCOPES,
  AUTH_FAILURES_PER_MINUTE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  IDEMPOTENCY_KEY_TTL_HOURS,
  MAX_PAGE_SIZE,
  PUBLIC_ERROR_CODES,
  PUBLIC_ERROR_STATUS,
  REQUEST_BODY_LIMIT_BYTES,
} from '@feedbouncer/public-api';
import {
  ACTION_SEVERITY,
  CONDITION_LIMITS,
  RULE_BUDGET_MS,
  RULE_MODES,
  ruleConditionsSchema,
} from '@feedbouncer/rules';

export interface ProductReference {
  rules: {
    conditions: { type: string; schema: object }[];
    limits: typeof CONDITION_LIMITS & { termCharsBeforeTrim: number };
    modes: typeof RULE_MODES;
    steps: { type: StepType; order: number; reversible: boolean; undo: string }[];
    conflicts: [StepType, StepType][];
    outcomes: string[];
    ruleBudgetMs: number;
  };
  api: {
    errors: { code: string; status: number }[];
    scopes: typeof API_KEY_SCOPES;
    page: { default: number; max: number };
    rateLimit: {
      defaultPerMinute: number;
      authFailuresPerMinute: number;
      env: 'PUBLIC_API_RATE_LIMIT_PER_MINUTE';
    };
    idempotencyKeyTtlHours: number;
    requestBodyLimitBytes: number;
  };
  moderationCheck: { reasons: string[] };
}

export function buildProductReference(): ProductReference {
  return {
    rules: {
      conditions: ruleConditionsSchema.def.options.map((option) => {
        const schema = z.toJSONSchema(option, { io: 'input' });
        const type = (option.shape.type as z.ZodLiteral<string>).value;
        return { type, schema };
      }),
      // Keyword terms and competitor names are trimmed before the termChars limit applies, so the
      // request schema admits twice that much raw input.
      limits: { ...CONDITION_LIMITS, termCharsBeforeTrim: CONDITION_LIMITS.termChars * 2 },
      modes: RULE_MODES,
      steps: STEP_TYPES.map((type, order) => ({
        type,
        order,
        reversible: STEP_META[type].reversibility === 'reversible',
        undo: STEP_META[type].undo ?? 'none',
      })),
      conflicts: CONFLICTS.map(([a, b]) => [a, b]),
      outcomes: Object.entries(ACTION_SEVERITY)
        .sort(([, a], [, b]) => a - b)
        .map(([outcome]) => outcome),
      ruleBudgetMs: RULE_BUDGET_MS,
    },
    api: {
      errors: PUBLIC_ERROR_CODES.map((code) => ({ code, status: PUBLIC_ERROR_STATUS[code] })),
      scopes: API_KEY_SCOPES,
      page: { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE },
      rateLimit: {
        defaultPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
        authFailuresPerMinute: AUTH_FAILURES_PER_MINUTE,
        env: 'PUBLIC_API_RATE_LIMIT_PER_MINUTE',
      },
      idempotencyKeyTtlHours: IDEMPOTENCY_KEY_TTL_HOURS,
      requestBodyLimitBytes: REQUEST_BODY_LIMIT_BYTES,
    },
    moderationCheck: { reasons: [...REASON_CODES] },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = new URL('../../../docs/reference/product-reference.json', import.meta.url);
  mkdirSync(new URL('.', file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(buildProductReference(), null, 2)}\n`);
}
