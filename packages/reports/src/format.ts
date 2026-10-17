import type { AdStat } from './stats.js';

const COUNT = new Intl.NumberFormat('en-US');
const PERCENT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const formatCount = (n: number): string => COUNT.format(n);

export const formatPercent = (part: number, whole: number): string =>
  `${PERCENT.format(whole === 0 ? 0 : (part / whole) * 100)}%`;

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return seconds > 0 ? 'under 1 min' : '0 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatChange(cur: number, prev: number): string {
  if (prev === 0 && cur > 0) return 'New this week (no comments the week before)';
  if (cur === prev) return 'Same as the week before';
  const sign = cur > prev ? '+' : '-';
  const delta = Math.abs(cur - prev);
  return `${sign}${formatCount(delta)} (${sign}${formatPercent(delta, prev)}) vs. the week before`;
}

/** `end` is exclusive, so the last day shown is the one containing end − 1 ms. */
export function formatRange(startIso: string, endIso: string, tz: string): string {
  const day = { timeZone: tz, month: 'short', day: 'numeric' } as const;
  const start = new Intl.DateTimeFormat('en-US', day).format(new Date(startIso));
  const end = new Intl.DateTimeFormat('en-US', { ...day, year: 'numeric' }).format(
    new Date(Date.parse(endIso) - 1),
  );
  return `${start} – ${end} (${tz})`;
}

const NAME_MAX = 80;
// C0/C1 controls, bidi marks/embeddings/overrides/isolates and line/paragraph separators.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeName(s: string): string {
  const points = [...s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()];
  return points.length > NAME_MAX ? `${points.slice(0, NAME_MAX).join('')}…` : points.join('');
}

export const adName = (a: AdStat): string => sanitizeName(a.name ?? '') || 'Unnamed ad';

export const adLabel = (a: AdStat): string =>
  `${adName(a)} · #${sanitizeName(a.externalId).slice(-6)}`;

const PLATFORMS = { facebook: 'Facebook', instagram: 'Instagram' } as const;

export const platformLabel = (p: AdStat['platforms']): string =>
  p.map((x) => PLATFORMS[x]).join(' + ');
