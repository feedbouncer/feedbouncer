import { WEEK_START_RE, type WeeklyStats } from '@feedbouncer/reports/shared';
import { dataOrThrow, serverGet } from './server-api';

/** GET /api/v1/orgs/:orgId/reports/weekly. */
export interface WeeklyReportDto {
  weekStart: string;
  timezone: string;
  source: 'snapshot' | 'live';
  stats: WeeklyStats;
  /** The workspace's report weeks, newest first. */
  weeks: string[];
}

/** A `?week=` value that is a real Monday (YYYY-MM-DD), or undefined. */
export function parseWeekParam(v: unknown): string | undefined {
  if (typeof v !== 'string' || !WEEK_START_RE.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) && d.getUTCDay() === 1
    ? v
    : undefined;
}

/** `week` defaults to the last complete week; null when the API refuses the week (400 invalid_week). */
export async function fetchWeeklyReport(
  orgId: string,
  week?: string,
): Promise<WeeklyReportDto | null> {
  const r = await serverGet<WeeklyReportDto>(
    `/api/v1/orgs/${orgId}/reports/weekly${week === undefined ? '' : `?week=${week}`}`,
  );
  return r.status === 400 ? null : dataOrThrow(r, 'weekly report');
}
