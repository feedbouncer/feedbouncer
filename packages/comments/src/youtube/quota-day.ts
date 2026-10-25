// The YouTube Data API quota day: the calendar date in America/Los_Angeles,
// resetting at 00:00 there. Intl only; DST is handled by re-reading the zone
// offset at the candidate instant.
const ZONE = 'America/Los_Angeles';
const DAY_MS = 86_400_000;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const offsetFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  timeZoneName: 'longOffset',
});

function wallDate(ms: number): { y: number; m: number; d: number } {
  const parts = dateFmt.formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** The zone's UTC offset at `ms`, in ms (negative west of UTC). */
function offsetMs(ms: number): number {
  const name = offsetFmt.formatToParts(ms).find((p) => p.type === 'timeZoneName')!.value;
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!m) throw new Error('unexpected time zone offset');
  if (!m[1]) return 0;
  const abs = (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  return m[1] === '-' ? -abs : abs;
}

/** 'YYYY-MM-DD' of `ms` in America/Los_Angeles. */
export function pacificDayKey(ms: number): string {
  const { y, m, d } = wallDate(ms);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The first Pacific midnight strictly after `ms`. */
export function nextPacificMidnight(ms: number): Date {
  const { y, m, d } = wallDate(ms);
  // Next local date at 00:00, read as if it were UTC.
  const wall = Date.UTC(y, m - 1, d) + DAY_MS;
  const guess = wall - offsetMs(wall);
  // The offset at the true instant differs when a DST change lies between the guess and it.
  return new Date(wall - offsetMs(guess));
}
