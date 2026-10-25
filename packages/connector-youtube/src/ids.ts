// Every YouTube id is checked against one of these before it is stored or put
// into a URL. The value is never echoed into the error.
import { ConnectorError } from '@feedbouncer/connectors';

export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Comment and thread ids; a reply id is `<parentId>.<replyId>`. */
export const COMMENT_ID = /^[A-Za-z0-9_.-]{10,200}$/;
export const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;

export type YouTubeIdKind = 'channel' | 'video' | 'comment' | 'thread' | 'pageToken';

const PATTERNS: Readonly<Record<YouTubeIdKind, RegExp>> = {
  channel: CHANNEL_ID,
  video: VIDEO_ID,
  comment: COMMENT_ID,
  thread: COMMENT_ID,
  pageToken: PAGE_TOKEN,
};

export function isId(kind: YouTubeIdKind, v: unknown): v is string {
  return typeof v === 'string' && PATTERNS[kind].test(v);
}

export function assertId(kind: YouTubeIdKind, v: unknown): string {
  if (!isId(kind, v)) throw new ConnectorError('permanent', 'invalid_platform_id');
  return v;
}
