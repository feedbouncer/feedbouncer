// Active-ad discovery. Every id and status from Graph is validated before it
// reaches a URL, a DB row or a log; one malformed ad never fails the page.
import {
  ConnectorError,
  type AdPlacement,
  type AdUnresolvedReason,
  type CallContext,
  type NormalizedSource,
  type Page,
} from '@feedbouncer/connectors';
import { adAccountNode, callFor, graphRequest } from '@feedbouncer/connector-facebook';
import * as z from 'zod';
import type { MetaAdsConfig } from './config.js';
import { mapAdsError } from './errors.js';

export const AD_FIELDS =
  'id,account_id,effective_status,updated_time,creative{id,effective_object_story_id,effective_instagram_media_id,instagram_user_id,object_type}';

const NUMERIC_ID = /^\d{1,32}$/;
const STORY_ID = /^\d{1,32}_\d{1,32}$/;
const STATUS = /^[A-Z_]{1,40}$/;
const PAGE_SIZE = 100;
const QUOTA_PCT = 90;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const valid = (v: unknown, re: RegExp): string | null =>
  typeof v === 'string' && re.test(v) ? v : null;
const present = (v: unknown) => v !== undefined && v !== null && v !== '';

const unresolved = (
  platform: AdPlacement['platform'],
  reason: AdUnresolvedReason,
  accountExternalId: string | null = null,
): AdPlacement => ({
  platform,
  accountExternalId,
  sourceExternalId: null,
  unresolvedReason: reason,
});

export function parseAd(
  raw: unknown,
  activeStatuses: readonly string[] = ['ACTIVE'],
): NormalizedSource | { skipped: 'invalid_ad' } {
  const ad = isObj(raw) ? raw : {};
  const id = valid(ad.id, NUMERIC_ID);
  const accountRaw = typeof ad.account_id === 'string' ? ad.account_id.replace(/^act_/, '') : null;
  const account = valid(accountRaw, NUMERIC_ID);
  const status = valid(ad.effective_status, STATUS);
  if (!id || !account || !status) return { skipped: 'invalid_ad' };

  const cr = isObj(ad.creative) ? ad.creative : {};
  const deleted = cr.object_type === 'POST_DELETED';
  const story = valid(cr.effective_object_story_id, STORY_ID);
  const media = valid(cr.effective_instagram_media_id, NUMERIC_ID);
  const igUser = valid(cr.instagram_user_id, NUMERIC_ID);

  let facebook: AdPlacement;
  if (deleted) facebook = unresolved('facebook', 'post_deleted');
  else if (story) {
    facebook = {
      platform: 'facebook',
      accountExternalId: story.slice(0, story.indexOf('_')),
      sourceExternalId: story,
      unresolvedReason: null,
    };
  } else if (present(cr.effective_object_story_id)) {
    facebook = unresolved('facebook', 'invalid_platform_id');
  } else if (cr.object_type === 'STORE_ITEM') {
    facebook = unresolved('facebook', 'dynamic_creative_unsupported');
  } else facebook = unresolved('facebook', 'no_post');

  let instagram: AdPlacement;
  if (deleted) {
    instagram = unresolved(
      'instagram',
      present(cr.effective_instagram_media_id) ? 'post_deleted' : 'not_instagram',
    );
  } else if (media) {
    instagram = {
      platform: 'instagram',
      accountExternalId: igUser,
      sourceExternalId: media,
      unresolvedReason: null,
    };
  } else if (present(cr.effective_instagram_media_id)) {
    instagram = unresolved('instagram', 'invalid_platform_id');
  } else if (igUser) instagram = unresolved('instagram', 'instagram_media_pending', igUser);
  else instagram = unresolved('instagram', 'not_instagram');

  return {
    externalId: id,
    kind: 'ad_post',
    permalink: null,
    active: activeStatuses.includes(status),
    ad: {
      adAccountExternalId: account,
      effectiveStatus: status,
      placements: [facebook, instagram],
    },
  };
}

const adsPage = z.object({
  data: z.array(z.unknown()).max(PAGE_SIZE),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

export async function listActiveAds(
  cfg: MetaAdsConfig,
  nowMs: () => number,
  ctx: CallContext,
  req: { cursor: string | null },
): Promise<Page<NormalizedSource>> {
  if (req.cursor !== null && req.cursor.length > 2048) {
    throw new ConnectorError('permanent', 'invalid_cursor');
  }
  const node = adAccountNode(ctx.externalAccountId);
  let r;
  try {
    r = await graphRequest(callFor(cfg.meta, nowMs, ctx), {
      method: 'GET',
      path: [node, 'ads'],
      query: {
        fields: AD_FIELDS,
        effective_status: JSON.stringify(cfg.activeStatuses),
        limit: String(PAGE_SIZE),
        ...(req.cursor ? { after: req.cursor } : {}),
      },
    });
  } catch (e) {
    throw mapAdsError(e);
  }
  const u = r.adAccountUsage;
  if (u && u.utilPct >= QUOTA_PCT) {
    void Promise.resolve(
      ctx.reportQuota({
        remaining: u.utilPct >= 100 ? 0 : 1,
        resetAt: new Date(nowMs() + u.resetMs),
      }),
    ).catch(() => undefined);
  }
  const page = adsPage.safeParse(r.body);
  if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
  const items: NormalizedSource[] = [];
  for (const raw of page.data.data) {
    const p = parseAd(raw, cfg.activeStatuses);
    if (!('skipped' in p)) items.push(p);
  }
  // Follow the cursor, never `paging.next`: the URL is rebuilt on the allowed host.
  const after = page.data.paging?.next ? page.data.paging.cursors?.after : undefined;
  return { items, nextCursor: after ?? null };
}
