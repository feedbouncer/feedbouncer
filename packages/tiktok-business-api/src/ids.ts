import { ConnectorError } from '@feedbouncer/connectors';

export const NUMERIC_ID = /^\d{1,32}$/;
export const OPAQUE_ID = /^[A-Za-z0-9_.:=-]{1,128}$/;
export const USERNAME = /^[A-Za-z0-9_.]{1,64}$/;

const invalidId = () => new ConnectorError('permanent', 'invalid_tiktok_id');
const invalidResponse = () => new ConnectorError('permanent', 'invalid_tiktok_response');

const idOf = (re: RegExp) => (v: unknown) => {
  if (typeof v !== 'string' || !re.test(v)) throw invalidId();
  return v;
};
export const numericId = idOf(NUMERIC_ID);
export const opaqueId = idOf(OPAQUE_ID);

export function username(v: unknown): string | null {
  return typeof v === 'string' && USERNAME.test(v) ? v : null;
}

/** Replaces NUL (rejected by Postgres text) and truncates by code point, never inside a surrogate pair. */
export function sanitizeText(v: string, maxCodePoints: number): string {
  return Array.from(v.replaceAll('\u0000', '�')).slice(0, maxCodePoints).join('');
}

const SHARE_HOSTS = new Set(['www.tiktok.com', 'vm.tiktok.com']);

export function safeShareUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const ok =
    u.protocol === 'https:' &&
    u.username === '' &&
    u.password === '' &&
    u.port === '' &&
    SHARE_HOSTS.has(u.hostname);
  return ok ? u.href : null;
}

/** Primary assumption for V20: an ad video resolves at /@/video/<item_id>. Change here if V20 says no (return null). */
export function adVideoPermalink(itemId: string): string | null {
  return NUMERIC_ID.test(itemId) ? `https://www.tiktok.com/@/video/${itemId}` : null;
}

const DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Accepts unix seconds (number or digit string) or 'YYYY-MM-DD HH:MM:SS' (UTC). */
export function tiktokTime(v: unknown): Date {
  let d: Date | null = null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) d = new Date(v * 1000);
  else if (typeof v === 'string' && /^\d{1,12}$/.test(v)) d = new Date(Number(v) * 1000);
  else if (typeof v === 'string' && DATETIME.test(v)) d = new Date(`${v.replace(' ', 'T')}Z`);
  // Date rolls over impossible values (month 13), so require a round trip.
  const roundTrips =
    d !== null &&
    !Number.isNaN(d.getTime()) &&
    (typeof v === 'number' ||
      /^\d+$/.test(String(v)) ||
      d.toISOString().slice(0, 19).replace('T', ' ') === v);
  if (!d || !roundTrips) throw invalidResponse();
  return d;
}
