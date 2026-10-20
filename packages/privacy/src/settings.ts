import { EnvError, readInt, type Env } from '@feedbouncer/service-runtime';

export const RETENTION_CATEGORIES = [
  'comments',
  'decisions',
  'previews',
  'operational',
  'audit',
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export type RetentionDays = number | 'forever';

export interface RetentionSettings {
  days: Record<RetentionCategory, RetentionDays>;
  purgeIntervalMinutes: number;
  batchSize: number;
  confirmAbove: number;
  maxRunMinutes: number;
}

export type RetentionWarning =
  | 'audit_below_recommended'
  | 'decisions_capped_by_comments'
  | 'builtin_shorter';

/** Limits that already apply regardless of configuration; the shorter period always wins. */
export const BUILTIN_LIMIT_DAYS = {
  previews: 7,
  webhookEvents: 30,
  idempotencyRecords: 1,
} as const;
export type BuiltinLimit = keyof typeof BUILTIN_LIMIT_DAYS;

/** The category whose rows each built-in limit already prunes. */
export const BUILTIN_LIMIT_CATEGORY = {
  previews: 'previews',
  webhookEvents: 'operational',
  idempotencyRecords: 'operational',
} as const satisfies Record<BuiltinLimit, RetentionCategory>;

export const AUDIT_RECOMMENDED_MIN_DAYS = 365;

const MAX_DAYS = 36_500;

export function parseRetentionDays(name: string, raw: string | undefined): RetentionDays {
  if (raw === undefined || raw === 'forever') return 'forever';
  const days = /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(days >= 1 && days <= MAX_DAYS)) {
    throw new EnvError(
      `${name} must be a whole number of days from 1 to ${MAX_DAYS}, or "forever" (got ${JSON.stringify(raw)}).`,
    );
  }
  return days;
}

export function loadRetentionSettings(env: Env): RetentionSettings {
  const days = Object.fromEntries(
    RETENTION_CATEGORIES.map((c) => {
      const name = `RETENTION_${c.toUpperCase()}_DAYS`;
      return [c, parseRetentionDays(name, env[name])];
    }),
  ) as Record<RetentionCategory, RetentionDays>;
  return {
    days,
    purgeIntervalMinutes: readInt(env, 'RETENTION_PURGE_INTERVAL_MINUTES', {
      min: 5,
      max: 1440,
      fallback: 60,
    }),
    batchSize: readInt(env, 'RETENTION_BATCH_SIZE', { min: 100, max: 10_000, fallback: 1000 }),
    confirmAbove: readInt(env, 'RETENTION_CONFIRM_ABOVE', {
      min: 0,
      max: 10_000_000,
      fallback: 10_000,
    }),
    maxRunMinutes: readInt(env, 'RETENTION_MAX_RUN_MINUTES', { min: 1, max: 120, fallback: 10 }),
  };
}

const length = (d: RetentionDays) => (d === 'forever' ? Infinity : d);

/** A configured period, shortened to the built-in limit of the rows it applies to (if any). */
export function withBuiltinLimit(days: RetentionDays, limit: BuiltinLimit | undefined): RetentionDays {
  if (limit === undefined) return days;
  return Math.min(length(days), BUILTIN_LIMIT_DAYS[limit]);
}

/** Built-in limits shorter than the configured period of their category, in declaration order. */
export function shorterBuiltinLimits(s: RetentionSettings): BuiltinLimit[] {
  return (Object.keys(BUILTIN_LIMIT_DAYS) as BuiltinLimit[]).filter(
    (limit) => length(s.days[BUILTIN_LIMIT_CATEGORY[limit]]) > BUILTIN_LIMIT_DAYS[limit],
  );
}

export function retentionWarnings(s: RetentionSettings): RetentionWarning[] {
  const { days } = s;
  const warnings: RetentionWarning[] = [];
  if (length(days.audit) < AUDIT_RECOMMENDED_MIN_DAYS) warnings.push('audit_below_recommended');
  if (length(days.decisions) > length(days.comments)) warnings.push('decisions_capped_by_comments');
  if (shorterBuiltinLimits(s).length > 0) warnings.push('builtin_shorter');
  return warnings;
}

/**
 * What applies per category. Previews is one table with a built-in limit, so the
 * whole category is capped. Operational is not: only webhook events and
 * idempotency records have built-in limits (applied per table by the purge via
 * withBuiltinLimit), while job and alert records keep the configured period.
 */
export function effectiveDays(s: RetentionSettings): Record<RetentionCategory, RetentionDays> {
  return { ...s.days, previews: withBuiltinLimit(s.days.previews, 'previews') };
}
