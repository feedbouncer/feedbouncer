import type { CallContext, NormalizedSource, Page } from '@feedbouncer/connectors';
import { NUMERIC_ID, safeShareUrl, tiktokRequest } from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import {
  callOf,
  checkCursor,
  nextCursor,
  onPermissionDenied,
  pageSchema,
  scopeMissing,
  type SkipLog,
} from './call.js';

const VIDEO_SCHEMA = z.object({ item_id: z.string().regex(NUMERIC_ID), share_url: z.unknown() });
const PAGE_SCHEMA = pageSchema('videos');
const PAGE_SIZE = 20;

export async function listSources(
  log: SkipLog,
  ctx: CallContext,
  req: { cursor: string | null },
): Promise<Page<NormalizedSource>> {
  const cursor = checkCursor(req.cursor);
  const { data } = await onPermissionDenied(
    () =>
      tiktokRequest(callOf(ctx), {
        endpoint: 'businessVideoList',
        method: 'GET',
        query: {
          business_id: ctx.externalAccountId,
          fields: JSON.stringify(['item_id', 'create_time', 'share_url']),
          max_count: String(PAGE_SIZE),
          ...(cursor !== null && { cursor }),
        },
        schema: PAGE_SCHEMA,
      }),
    () => scopeMissing('video.list'),
  );
  const items: NormalizedSource[] = [];
  for (const raw of data.videos) {
    const v = VIDEO_SCHEMA.safeParse(raw);
    if (v.success) {
      items.push({
        externalId: v.data.item_id,
        kind: 'video',
        permalink: safeShareUrl(v.data.share_url),
        active: true,
      });
    }
  }
  if (items.length < data.videos.length) {
    log('tiktok items skipped', { code: 'invalid_item', count: data.videos.length - items.length });
  }
  return { items, nextCursor: nextCursor(data) };
}
