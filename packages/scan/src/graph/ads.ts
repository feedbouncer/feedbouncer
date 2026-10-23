// Recent ad posts of one Page (and its linked Instagram account), read from the
// user's ad accounts. Graph ids are validated by the connector helpers.
import { ConnectorError, type CallContext } from '@feedbouncer/connectors';
import {
  callFor,
  adAccountNode,
  graphRequest,
  parseGraphTime,
} from '@feedbouncer/connector-facebook';
import { AD_FIELDS, listAdAccounts, mapAdsError, parseAd } from '@feedbouncer/connector-meta-ads';
import type { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import { MAX_AD_ACCOUNTS, MAX_AD_PAGES_PER_ACCOUNT, MAX_ADS, WINDOW_DAYS } from '../limits.js';
import { scanCallContext, type ScanGraph } from './pages.js';

export interface AdPost {
  ordinal: number;
  platform: 'facebook' | 'instagram';
  postExternalId: string;
  adIds: string[];
  label: string | null;
  createdAt: Date;
}

const DAY_MS = 86_400_000;
const PAGE_SIZE = 100;
const CURSOR = /^[A-Za-z0-9=_-]{1,512}$/;
const EFFECTIVE_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'CAMPAIGN_PAUSED',
  'ADSET_PAUSED',
  'ARCHIVED',
  'WITH_ISSUES',
];

const adsPage = z.object({
  data: z.array(z.unknown()).max(PAGE_SIZE),
  paging: z
    .object({
      cursors: z.object({ after: z.string().regex(CURSOR).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
const times = z.object({ created_time: z.string().max(40), updated_time: z.string().max(40) });

async function* adsOf(
  g: ScanGraph,
  ctx: CallContext,
  adAccountId: string,
): AsyncGenerator<unknown> {
  const call = callFor(g.fb, g.nowMs, ctx);
  let after: string | undefined;
  for (let i = 0; i < MAX_AD_PAGES_PER_ACCOUNT; i++) {
    let body;
    try {
      ({ body } = await graphRequest(call, {
        method: 'GET',
        path: [adAccountNode(adAccountId), 'ads'],
        query: {
          fields: `${AD_FIELDS},created_time`,
          effective_status: JSON.stringify(EFFECTIVE_STATUSES),
          limit: String(PAGE_SIZE),
          ...(after ? { after } : {}),
        },
      }));
    } catch (e) {
      throw mapAdsError(e);
    }
    const page = adsPage.safeParse(body);
    if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
    yield* page.data.data;
    // Follow the cursor, never `paging.next`.
    after = page.data.paging?.next ? page.data.paging.cursors?.after : undefined;
    if (!after) return;
  }
}

export async function discoverRecentAdPosts(
  g: ScanGraph,
  userToken: Secret,
  target: { pageId: string; igUserId: string | null },
  signal: AbortSignal,
): Promise<AdPost[]> {
  const { http } = scanCallContext(g, userToken, 'me', signal);
  const accounts = (await listAdAccounts(g.meta, g.nowMs, userToken, { http, signal })).slice(
    0,
    MAX_AD_ACCOUNTS,
  );
  const cutoff = g.nowMs() - WINDOW_DAYS * DAY_MS;
  const posts = new Map<string, Omit<AdPost, 'ordinal'>>();

  for (const account of accounts) {
    const ctx = scanCallContext(g, userToken, account.externalAccountId, signal);
    for await (const raw of adsOf(g, ctx, account.externalAccountId)) {
      const parsed = parseAd(raw);
      const t = times.safeParse(raw);
      if ('skipped' in parsed || !parsed.ad || !t.success) continue;
      const createdAt = parseGraphTime(t.data.created_time);
      const updatedAt = parseGraphTime(t.data.updated_time);
      if (!createdAt || !updatedAt) continue;
      if (!parsed.active && updatedAt.getTime() < cutoff) continue;

      for (const p of parsed.ad.placements) {
        const wanted =
          p.platform === 'facebook'
            ? p.accountExternalId === target.pageId
            : target.igUserId !== null && p.accountExternalId === target.igUserId;
        if (!wanted || p.sourceExternalId === null) continue;
        const key = `${p.platform}:${p.sourceExternalId}`;
        const post = posts.get(key);
        if (!post) {
          posts.set(key, {
            platform: p.platform,
            postExternalId: p.sourceExternalId,
            adIds: [parsed.externalId],
            label: parsed.ad.name,
            createdAt,
          });
          continue;
        }
        if (!post.adIds.includes(parsed.externalId)) post.adIds.push(parsed.externalId);
        if (createdAt > post.createdAt) {
          post.label = parsed.ad.name;
          post.createdAt = createdAt;
        }
      }
    }
  }

  return [...posts.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_ADS)
    .map((p, i) => ({ ordinal: i + 1, ...p }));
}
