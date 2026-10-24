import type { GrantableAccount, OAuthContext } from '@feedbouncer/connectors';
import type { Secret } from '@feedbouncer/service-runtime';
import { numericId, sanitizeText, tiktokRequest } from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import type { TikTokAdsConfig } from './config.js';

const LIST_SCHEMA = z.object({ list: z.array(z.unknown()).max(500) });
const ADVERTISER = z.object({
  advertiser_id: z.string(),
  advertiser_name: z.string().max(500).optional(),
});

/** Every advertiser the grant covers; entries with a malformed id are dropped. */
export async function listAccounts(
  cfg: TikTokAdsConfig,
  userToken: Secret,
  ctx: OAuthContext,
): Promise<readonly GrantableAccount[]> {
  const { data } = await tiktokRequest(
    { http: ctx.http, signal: ctx.signal, accessToken: userToken.reveal() },
    {
      endpoint: 'adAdvertiserGet',
      method: 'GET',
      query: { app_id: cfg.appId, secret: cfg.appSecret },
      schema: LIST_SCHEMA,
    },
  );
  return data.list.flatMap((raw): GrantableAccount[] => {
    const r = ADVERTISER.safeParse(raw);
    if (!r.success) return [];
    let externalAccountId: string;
    try {
      externalAccountId = numericId(r.data.advertiser_id);
    } catch {
      return [];
    }
    const name = r.data.advertiser_name;
    return [
      {
        externalAccountId,
        displayName: name === undefined ? null : sanitizeText(name, 200),
        eligible: true,
        ineligibleReason: null,
        limitations: [],
        accessToken: userToken,
      },
    ];
  });
}
