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

export function retentionWarnings(s: RetentionSettings): RetentionWarning[] {
  const { days } = s;
  const warnings: RetentionWarning[] = [];
  if (length(days.audit) < AUDIT_RECOMMENDED_MIN_DAYS) warnings.push('audit_below_recommended');
  if (length(days.decisions) > length(days.comments)) warnings.push('decisions_capped_by_comments');
  if (
    length(days.previews) > BUILTIN_LIMIT_DAYS.previews ||
    length(days.operational) > BUILTIN_LIMIT_DAYS.idempotencyRecords
  ) {
    warnings.push('builtin_shorter');
  }
  return warnings;
}

/** What actually applies: previews are never kept past their built-in 7 days. */
export function effectiveDays(s: RetentionSettings): Record<RetentionCategory, RetentionDays> {
  return { ...s.days, previews: Math.min(length(s.days.previews), BUILTIN_LIMIT_DAYS.previews) };
}
