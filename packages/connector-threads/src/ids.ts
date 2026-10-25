import { ConnectorError } from '@feedbouncer/connectors';

/** A Threads media id (post or reply): digits only, so it is safe in a path segment. */
export const MEDIA_ID = /^\d{1,32}$/;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;
const PERMALINK_HOSTS: ReadonlySet<string> = new Set([
  'www.threads.com',
  'www.threads.net',
  'threads.com',
  'threads.net',
]);
const ISO_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})$/;

export function mediaId(v: unknown): string {
  if (typeof v !== 'string' || !MEDIA_ID.test(v)) {
    throw new ConnectorError('permanent', 'invalid_threads_id');
  }
  return v;
}

export function username(v: unknown): string | null {
  return typeof v === 'string' && USERNAME.test(v) ? v : null;
}

/** NUL becomes U+FFFD, then at most `maxCodePoints` code points; a surrogate pair is never split. */
export function sanitizeText(v: unknown, maxCodePoints: number): string {
  if (typeof v !== 'string') return '';
  // A code point is at most two UTF-16 units, so this bounds the work on hostile input.
  const bounded = v.slice(0, maxCodePoints * 2).replaceAll('\u0000', '�');
  return Array.from(bounded).slice(0, maxCodePoints).join('');
}

export function safePermalink(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !PERMALINK_HOSTS.has(url.hostname)
  ) {
    return null;
  }
  return url.href;
}

export function safeCursor(v: unknown): string | null {
  return typeof v === 'string' && CURSOR.test(v) ? v : null;
}

/** ISO 8601, including Threads' `+0000` offset without a colon. */
export function threadsTime(v: unknown): Date {
  const m = typeof v === 'string' ? ISO_TIME.exec(v) : null;
  if (m) {
    const zone = m[2]!;
    const offset = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
    const d = new Date(`${m[1]}${offset}`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new ConnectorError('permanent', 'invalid_threads_response');
}
