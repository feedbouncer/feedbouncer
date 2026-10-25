import { ConnectorError, parseRetryAfter, type SafeHttp } from '@feedbouncer/connectors';
import { z } from 'zod';
import { THREADS_API_HOST } from './config.js';
import { mapThreadsError } from './errors.js';
import { MEDIA_ID } from './ids.js';

export { THREADS_API_HOST };

export type ThreadsEndpoint =
  | 'me'
  | 'meThreads'
  | 'media'
  | 'conversation'
  | 'replies'
  | 'manageReply'
  | 'createContainer'
  | 'publish'
  | 'publishingLimit'
  | 'oauthToken'
  | 'longLived'
  | 'refresh'
  | 'debugToken';

/** The closed path table: `{id}` is the only variable segment and must match MEDIA_ID. */
const PATHS: Readonly<Record<ThreadsEndpoint, string>> = {
  me: '/v1.0/me',
  meThreads: '/v1.0/me/threads',
  media: '/v1.0/{id}',
  conversation: '/v1.0/{id}/conversation',
  replies: '/v1.0/{id}/replies',
  manageReply: '/v1.0/{id}/manage_reply',
  createContainer: '/v1.0/me/threads',
  publish: '/v1.0/{id}/threads_publish',
  publishingLimit: '/v1.0/{id}/threads_publishing_limit',
  oauthToken: '/oauth/access_token',
  longLived: '/access_token',
  refresh: '/refresh_access_token',
  debugToken: '/v1.0/debug_token',
};

const invalidRequest = () => new ConnectorError('permanent', 'invalid_request');

/** Throws permanent/invalid_request for an unknown endpoint, a bad id or a missing/stray id. */
export function threadsPath(endpoint: ThreadsEndpoint, id?: string): string {
  if (!Object.hasOwn(PATHS, endpoint)) throw invalidRequest();
  const template = PATHS[endpoint];
  if (!template.includes('{id}')) {
    if (id !== undefined) throw invalidRequest();
    return template;
  }
  if (typeof id !== 'string' || !MEDIA_ID.test(id)) throw invalidRequest();
  return template.replace('{id}', id);
}

export interface ThreadsCall {
  readonly http: SafeHttp;
  readonly signal: AbortSignal;
  /** Sent as a bearer header only, never in the URL. */
  readonly accessToken?: string;
  /** Epoch ms; defaults to Date.now. */
  readonly now?: () => number;
}

const TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GraphError = z.object({
  error: z.object({
    code: z.number().int().optional(),
    error_subcode: z.number().int().optional(),
  }),
});

/**
 * Errors carry only a code: never the URL, query, Meta's message, tokens or request fields.
 * The query string may hold the app secret (th_exchange_token), so nothing here logs or throws it.
 */
export async function threadsRequest<T>(
  call: ThreadsCall,
  req: {
    readonly endpoint: ThreadsEndpoint;
    readonly id?: string;
    readonly method: 'GET' | 'POST';
    readonly query?: Readonly<Record<string, string>>;
    readonly form?: Readonly<Record<string, string>>;
    readonly schema: z.ZodType<T>;
  },
): Promise<{ data: T; traceId: string | null }> {
  const url = new URL(threadsPath(req.endpoint, req.id), `https://${THREADS_API_HOST}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);

  const res = await call.http.request(
    {
      method: req.method,
      url,
      headers: {
        ...(call.accessToken !== undefined && { authorization: `Bearer ${call.accessToken}` }),
        ...(req.method === 'POST' && { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(req.method === 'POST' && { body: new URLSearchParams(req.form ?? {}).toString() }),
    },
    call.signal,
  );

  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), (call.now ?? Date.now)());
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    if (res.status >= 400) {
      throw mapThreadsError({ httpStatus: res.status, code: null, subcode: null, retryAfterMs });
    }
    throw new ConnectorError('permanent', 'invalid_threads_response');
  }
  const err = GraphError.safeParse(json);
  if (res.status >= 400 || err.success) {
    throw mapThreadsError({
      httpStatus: res.status,
      code: err.success ? (err.data.error.code ?? null) : null,
      subcode: err.success ? (err.data.error.error_subcode ?? null) : null,
      retryAfterMs,
    });
  }
  const data = req.schema.safeParse(json);
  if (!data.success) throw new ConnectorError('permanent', 'invalid_threads_response');
  const trace = res.headers.get('x-fb-trace-id');
  return { data: data.data, traceId: trace !== null && TRACE_ID.test(trace) ? trace : null };
}
