// Ad account picker: the user's ad accounts, one grantable entry each.
import { ConnectorError, type GrantableAccount, type OAuthContext } from '@feedbouncer/connectors';
import { graphRequest, type GraphCall } from '@feedbouncer/connector-facebook';
import type { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import type { MetaAdsConfig } from './config.js';
import { mapAdsError } from './errors.js';

const MAX_PAGES = 20;
const NAME_CODE_POINTS = 200;

const accountsPage = z.object({
  data: z.array(z.unknown()).max(200),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
const entry = z.object({
  account_id: z.string().regex(/^\d{1,32}$/),
  name: z.string().max(500).optional(),
  account_status: z.number().int().optional(),
});

const INELIGIBLE: Readonly<Record<number, string>> = {
  2: 'ad_account_disabled',
  3: 'ad_account_unsettled',
  101: 'ad_account_closed',
};

export async function listAdAccounts(
  cfg: MetaAdsConfig,
  nowMs: () => number,
  userToken: Secret,
  ctx: OAuthContext,
): Promise<readonly GrantableAccount[]> {
  const c: GraphCall = {
    http: ctx.http,
    signal: ctx.signal,
    version: cfg.meta.graphVersion,
    appSecret: cfg.meta.appSecret,
    token: userToken,
    nowMs,
  };
  const out: GrantableAccount[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    let body: unknown;
    try {
      body = (
        await graphRequest(c, {
          method: 'GET',
          path: ['me', 'adaccounts'],
          query: {
            fields: 'id,account_id,name,account_status',
            limit: '100',
            ...(after ? { after } : {}),
          },
        })
      ).body;
    } catch (e) {
      throw mapAdsError(e);
    }
    const page = accountsPage.safeParse(body);
    if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
    for (const raw of page.data.data) {
      const e = entry.safeParse(raw);
      if (!e.success) continue; // one malformed entry must not hide the others
      const eligible = e.data.account_status === 1;
      out.push({
        externalAccountId: e.data.account_id,
        displayName:
          e.data.name === undefined
            ? null
            : Array.from(e.data.name.replaceAll('\u0000', '�')).slice(0, NAME_CODE_POINTS).join(''),
        eligible,
        ineligibleReason: eligible
          ? null
          : (INELIGIBLE[e.data.account_status ?? -1] ?? 'ad_account_unavailable'),
        limitations: [],
        accessToken: userToken,
      });
    }
    // Follow the cursor, never the `next` URL.
    after = page.data.paging?.next ? page.data.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}
