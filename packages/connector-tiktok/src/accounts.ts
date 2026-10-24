import {
  type CallContext,
  type GrantableAccount,
  type OAuthContext,
} from '@feedbouncer/connectors';
import type { Secret } from '@feedbouncer/service-runtime';
import {
  isPermissionDenied,
  sanitizeText,
  scopeMissing,
  tiktokRequest,
} from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';

const BUSINESS = z.object({
  business_id: z.string(),
  username: z.string().max(500).optional(),
  display_name: z.string().max(500).optional(),
});

/** V5: the token's own account. Pass `businessId` when it is already known (fresh token response). */
export async function fetchBusinessAccount(
  ctx: Pick<OAuthContext | CallContext, 'http' | 'signal'>,
  token: Secret,
  businessId?: string,
): Promise<{ externalAccountId: string; displayName: string | null }> {
  const { data } = await tiktokRequest(
    { http: ctx.http, signal: ctx.signal, accessToken: token.reveal() },
    {
      endpoint: 'businessGet',
      method: 'GET',
      query: {
        ...(businessId !== undefined && { business_id: businessId }),
        fields: JSON.stringify(['username', 'display_name']),
      },
      schema: BUSINESS,
    },
  ).catch((e: unknown) => {
    throw isPermissionDenied(e) ? scopeMissing('user.info.basic') : e;
  });
  const name = data.username ?? data.display_name;
  return {
    externalAccountId: data.business_id,
    displayName: name === undefined ? null : sanitizeText(name, 200),
  };
}

/** The grant covers exactly one account. The framework validates its id against `accountIdPattern`. */
export async function listAccounts(
  userToken: Secret,
  ctx: OAuthContext,
): Promise<readonly GrantableAccount[]> {
  const a = await fetchBusinessAccount(ctx, userToken);
  return [
    { ...a, eligible: true, ineligibleReason: null, limitations: [], accessToken: userToken },
  ];
}
