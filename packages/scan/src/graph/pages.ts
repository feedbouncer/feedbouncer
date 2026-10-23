// Page picker and Page resolution for a scan. Every Graph read goes through
// readOnlyHttp; Page access tokens are only ever handed back as `Secret`.
import { ConnectorError, type CallContext, type SafeHttp } from '@feedbouncer/connectors';
import {
  GRAPH_ID,
  callFor,
  graphId,
  graphRequest,
  type FacebookConfig,
} from '@feedbouncer/connector-facebook';
import type { InstagramConfig } from '@feedbouncer/connector-instagram';
import type { MetaAdsConfig } from '@feedbouncer/connector-meta-ads';
import { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import type { ScanPageOption } from '../contract.js';
import { readOnlyHttp } from './read-only-http.js';

const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const MODERATE = 'MODERATE';

export interface ScanGraph {
  fb: FacebookConfig;
  ig: InstagramConfig;
  meta: MetaAdsConfig;
  http: SafeHttp;
  nowMs: () => number;
}

/** The scan reads Instagram through the same Meta app as Facebook, and ads through `metaAds` when configured. */
export function createScanGraph(
  fb: FacebookConfig,
  metaAds: MetaAdsConfig | null | undefined,
  http: SafeHttp,
): ScanGraph {
  return {
    fb,
    ig: { meta: fb },
    meta: metaAds ?? { meta: fb, activeStatuses: ['ACTIVE'] },
    http: readOnlyHttp(http),
    nowMs: Date.now,
  };
}

export function scanCallContext(
  g: ScanGraph,
  token: Secret,
  externalAccountId: string,
  signal: AbortSignal,
): CallContext {
  return {
    accessToken: token,
    externalAccountId,
    http: readOnlyHttp(g.http),
    signal,
    reportQuota: async () => undefined,
  };
}

const gid = z.string().regex(GRAPH_ID);
const tasks = z.array(z.string().max(60)).max(100).default([]);

const accountsPage = z.object({
  data: z.array(z.unknown()).max(PAGE_SIZE),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
const pageEntry = z.object({
  id: gid,
  name: z.string().max(500),
  tasks,
  instagram_business_account: z
    .object({ id: gid, username: z.string().max(100).optional() })
    .optional(),
});
const pageDetail = z.object({
  access_token: z.string().min(1).max(4096),
  tasks,
  instagram_business_account: z.object({ id: gid }).optional(),
});

export async function listScanPages(
  g: ScanGraph,
  userToken: Secret,
  signal: AbortSignal,
): Promise<ScanPageOption[]> {
  const call = callFor(g.fb, g.nowMs, scanCallContext(g, userToken, 'me', signal));
  const out: ScanPageOption[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { body } = await graphRequest(call, {
      method: 'GET',
      path: ['me', 'accounts'],
      query: {
        fields: 'id,name,tasks,instagram_business_account{id,username}',
        limit: String(PAGE_SIZE),
        ...(after ? { after } : {}),
      },
    });
    const page = accountsPage.safeParse(body);
    if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
    for (const raw of page.data.data) {
      const e = pageEntry.safeParse(raw);
      if (!e.success) continue; // one malformed Page must not hide the others
      const eligible = e.data.tasks.includes(MODERATE);
      out.push({
        pageId: e.data.id,
        name: e.data.name,
        igUserId: e.data.instagram_business_account?.id ?? null,
        igUsername: e.data.instagram_business_account?.username ?? null,
        eligible,
        ineligibleReason: eligible ? null : 'insufficient_page_role',
      });
    }
    // Follow the cursor, never `paging.next`.
    after = page.data.paging?.next ? page.data.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

const permissions = z.object({
  data: z.array(z.object({ permission: z.string().max(64), status: z.string().max(20) })).max(200),
});

/** The permissions the user token currently holds. */
export async function grantedScopes(
  g: ScanGraph,
  userToken: Secret,
  signal: AbortSignal,
): Promise<string[]> {
  const { body } = await graphRequest(
    callFor(g.fb, g.nowMs, scanCallContext(g, userToken, 'me', signal)),
    { method: 'GET', path: ['me', 'permissions'] },
  );
  const page = permissions.safeParse(body);
  if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
  return page.data.data.filter((p) => p.status === 'granted').map((p) => p.permission);
}

export async function resolvePage(
  g: ScanGraph,
  userToken: Secret,
  pageId: string,
  signal: AbortSignal,
): Promise<{ pageToken: Secret; canModerate: boolean; igUserId: string | null }> {
  const { body } = await graphRequest(
    callFor(g.fb, g.nowMs, scanCallContext(g, userToken, graphId(pageId), signal)),
    {
      method: 'GET',
      path: [graphId(pageId)],
      query: { fields: 'access_token,tasks,instagram_business_account{id}' },
    },
  );
  const page = pageDetail.safeParse(body);
  if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
  return {
    pageToken: new Secret(page.data.access_token),
    canModerate: page.data.tasks.includes(MODERATE),
    igUserId: page.data.instagram_business_account?.id ?? null,
  };
}
