// Limits and input rules of workspace tags and the done queue. Free of Node and database imports,
// so the web app checks a tag name with the same rules the API applies.
export const TAG_NAME_MAX = 50;
export const TAGS_PER_ORG = 200;
export const TAGS_PER_COMMENT = 20;
export const BULK_MAX = 100;
export const TAG_IDS_MAX = 10;

export const QUEUES = ['open', 'done', 'all'] as const;
export type Queue = (typeof QUEUES)[number];

export type TagNameError = 'empty' | 'too_long' | 'control_chars';

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

export function parseTagName(
  raw: string,
): { ok: true; name: string; key: string } | { ok: false; error: TagNameError } {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'empty' };
  if ([...name].length > TAG_NAME_MAX) return { ok: false, error: 'too_long' };
  if (CONTROL_CHARS.test(name)) return { ok: false, error: 'control_chars' };
  return { ok: true, name, key: name.normalize('NFC').toLowerCase() };
}
