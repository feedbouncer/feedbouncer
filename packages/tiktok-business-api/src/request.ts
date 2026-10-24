import {
  ConnectorError,
  parseRetryAfter,
  type CallContext,
  type SafeHttp,
} from '@feedbouncer/connectors';
import { z } from 'zod';
import { mapTikTokError } from './errors.js';
import { TIKTOK_API_HOST, TIKTOK_ENDPOINTS, type TikTokEndpoint } from './endpoints.js';

export interface TikTokCall {
  readonly http: SafeHttp;
  readonly signal: AbortSignal;
  /** Sent as the Access-Token header only. */
  readonly accessToken?: string;
  readonly reportQuota?: CallContext['reportQuota'];
}
export interface TikTokResult<T> {
  readonly data: T;
  readonly requestId: string | null;
}

const Envelope = z.object({
  code: z.number().int(),
  request_id: z.unknown().optional(),
  data: z.unknown().optional(),
});
const REQUEST_ID = /^[A-Za-z0-9]{1,64}$/;

/** Errors carry only a code: never the URL, the TikTok message, tokens or request fields. */
export async function tiktokRequest<T>(
  call: TikTokCall,
  req: {
    readonly endpoint: TikTokEndpoint;
    readonly method: 'GET' | 'POST';
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: Readonly<Record<string, unknown>>;
    readonly schema: z.ZodType<T>;
  },
): Promise<TikTokResult<T>> {
  if (!Object.hasOwn(TIKTOK_ENDPOINTS, req.endpoint)) {
    throw new ConnectorError('permanent', 'invalid_request');
  }
  const url = new URL(
    `/open_api/v1.3/${TIKTOK_ENDPOINTS[req.endpoint]}`,
    `https://${TIKTOK_API_HOST}`,
  );
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);

  const res = await call.http.request(
    {
      method: req.method,
      url,
      headers: {
        ...(call.accessToken !== undefined && { 'access-token': call.accessToken }),
        ...(req.method === 'POST' && { 'content-type': 'application/json' }),
      },
      ...(req.method === 'POST' && { body: JSON.stringify(req.body ?? {}) }),
    },
    call.signal,
  );

  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), Date.now());
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw res.status >= 500
      ? mapTikTokError({ httpStatus: res.status, code: null, retryAfterMs })
      : new ConnectorError('permanent', 'invalid_tiktok_response');
  }
  const env = Envelope.safeParse(json);
  const code = env.success ? env.data.code : null;
  if (res.status >= 400 || (code !== null && code !== 0)) {
    throw mapTikTokError({ httpStatus: res.status, code, retryAfterMs });
  }
  if (!env.success) throw new ConnectorError('permanent', 'invalid_tiktok_response');
  const data = req.schema.safeParse(env.data.data);
  if (!data.success) throw new ConnectorError('permanent', 'invalid_tiktok_response');
  const rid = env.data.request_id;
  return {
    data: data.data,
    requestId: typeof rid === 'string' && REQUEST_ID.test(rid) ? rid : null,
  };
}
