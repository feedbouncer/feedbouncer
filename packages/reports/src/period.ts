import type pg from 'pg';
import { SEND_HOUR_LOCAL } from './constants.js';

export interface ReportPeriod {
  /** Local Monday of the reported week, YYYY-MM-DD. */
  weekStart: string;
  timezone: string;
  start: Date;
  end: Date;
  prevStart: Date;
  /** The instant the report becomes due: Monday SEND_HOUR_LOCAL:00 local after the week ends. */
  dueAt: Date;
}

interface Row {
  week_start: string;
  start: Date;
  end: Date;
  prev_start: Date;
  due_at: Date;
  monday: boolean;
}

// `m` is the local Monday 00:00 that ends the reported week. All arithmetic is on
// local timestamps, so DST shifts never move a boundary off local midnight.
const query = (m: string) => `
  WITH w AS (SELECT ${m} AS m)
  SELECT to_char(m - interval '7 days', 'YYYY-MM-DD') AS week_start,
         (m - interval '7 days') AT TIME ZONE $1 AS start,
         m AT TIME ZONE $1 AS "end",
         (m - interval '14 days') AT TIME ZONE $1 AS prev_start,
         (m + make_interval(hours => $3)) AT TIME ZONE $1 AS due_at,
         extract(isodow FROM m) = 1 AS monday
    FROM w`;

const REPORT_SQL = query(`date_trunc('week', $2::timestamptz AT TIME ZONE $1)`);
const WEEK_SQL = query(`$2::date + interval '7 days'`);

const toPeriod = (timezone: string, r: Row): ReportPeriod => ({
  weekStart: r.week_start,
  timezone,
  start: r.start,
  end: r.end,
  prevStart: r.prev_start,
  dueAt: r.due_at,
});

/** The previous complete Mon-Sun week relative to `now` in `timezone`. */
export async function reportPeriod(
  c: pg.ClientBase,
  timezone: string,
  now: Date,
): Promise<ReportPeriod> {
  const { rows } = await c.query<Row>(REPORT_SQL, [timezone, now, SEND_HOUR_LOCAL]);
  return toPeriod(timezone, rows[0]!);
}

/** The period for an explicit local Monday (dashboard); null if `weekStart` isn't a Monday. */
export async function periodForWeek(
  c: pg.ClientBase,
  timezone: string,
  weekStart: string,
): Promise<ReportPeriod | null> {
  const { rows } = await c.query<Row>(WEEK_SQL, [timezone, weekStart, SEND_HOUR_LOCAL]);
  const row = rows[0]!;
  return row.monday ? toPeriod(timezone, row) : null;
}
