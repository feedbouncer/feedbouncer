import { z } from 'zod';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** How far back the quota ledger can be read. */
const MAX_DAYS_BACK = 90;

/** The body schema for a connection whose budget ceiling is `maxBudgetUnits`. */
export const youtubeSettingsPatch = (maxBudgetUnits: number) =>
  z.strictObject({
    dailyBudgetUnits: z.number().int().min(0).max(maxBudgetUnits).optional(),
    dryRun: z.boolean().optional(),
    protectedAuthorIds: z
      .array(z.string().regex(CHANNEL_ID))
      .max(200)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  });

/** A calendar date no more than 90 days before `today` ('YYYY-MM-DD'); an impossible date fails. */
export const quotaDay = (today: string) =>
  z
    .string()
    .regex(DAY)
    .refine((day) => {
      const [y, m, d] = day.split('-').map(Number) as [number, number, number];
      const at = new Date(Date.UTC(y, m - 1, d));
      if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return false;
      const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
      return (Date.UTC(ty, tm - 1, td) - at.getTime()) / DAY_MS <= MAX_DAYS_BACK;
    });
