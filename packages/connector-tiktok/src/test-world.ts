import { vi, type Mock } from 'vitest';
import { createSafeHttp, type CallContext, type OAuthContext } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { TIKTOK_API_HOST } from '@feedbouncer/tiktok-business-api';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import { createTikTokConnector } from './connector.js';

const APP = { appId: '7300000000000001', appSecret: 'tiktok-app-SECRET-0123456789' };
type Log = (msg: string, fields: { code: string; count?: number }) => void;

/** A connected account with one video. `tamper` rewrites the JSON `data` of responses for `path`. */
export async function world() {
  const fake = new FakeTikTok(APP);
  const log: Mock<Log> = vi.fn<Log>();
  const connector = createTikTokConnector(
    { ...APP, appSecret: new Secret(APP.appSecret) },
    { log },
  );
  let tamper: { path: string; fn: (data: Record<string, unknown>) => unknown } | null = null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await fake.fetch(input, init);
    if (!tamper || !String(input).includes(tamper.path)) return res;
    const json = (await res.json()) as { data: Record<string, unknown> };
    return Response.json({ ...json, data: tamper.fn(json.data) });
  };
  const http = createSafeHttp({ allowedHosts: [TIKTOK_API_HOST], fetch });
  const signal = AbortSignal.timeout(5000);
  const oauth: OAuthContext = { http, signal, redirectUri: 'https://app.test/cb' };
  const { businessId, authCode } = fake.addBusinessAccount({ username: 'shop' });
  const { tokens } = await connector.exchangeCode(
    { code: new Secret(authCode), codeVerifier: new Secret('v') },
    oauth,
  );
  const ctx: CallContext = {
    accessToken: tokens.accessToken,
    externalAccountId: businessId,
    http,
    signal,
    reportQuota: async () => {},
  };
  const { itemId } = fake.addVideo(businessId);
  return {
    fake,
    connector,
    ctx,
    log,
    businessId,
    itemId,
    tamper: (path: string, fn: (d: Record<string, unknown>) => unknown) => (tamper = { path, fn }),
  };
}
