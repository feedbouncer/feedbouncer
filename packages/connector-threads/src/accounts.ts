import { ConnectorError, type GrantableAccount } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import type { ThreadsCall } from './api.js';
import { fetchMe } from './oauth.js';

/** Exactly one account: the Threads profile behind the token (`GET me`). */
export async function listAccounts(call: ThreadsCall): Promise<readonly GrantableAccount[]> {
  if (call.accessToken === undefined) throw new ConnectorError('auth_expired', 'token_invalid');
  const me = await fetchMe(call);
  return [
    {
      externalAccountId: me.id,
      displayName: me.name,
      eligible: true,
      ineligibleReason: null,
      limitations: [],
      accessToken: new Secret(call.accessToken),
    },
  ];
}
