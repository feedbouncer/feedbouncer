import { NodeOperationError, sleep } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, IHookFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { version } from '../../package.json';
import { normalizeBaseUrl } from './baseUrl';
import {
  CREDENTIAL_NAME,
  DEFAULT_BACKOFF_SECONDS,
  MAX_429_RETRIES,
  MAX_RETRY_AFTER_SECONDS,
  REQUEST_TIMEOUT_MS,
} from './constants';
import type { REQUIRED_OPERATIONS } from './constants';
import { apiErrorEnvelope, describeFailure, toNodeApiError } from './errors';

type Ctx = IExecuteFunctions | IHookFunctions;

export interface FbRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: `/v1/${string}`;
  qs?: IDataObject;
  body?: IDataObject;
  idempotencyKey?: string;
  operationId: (typeof REQUIRED_OPERATIONS)[number];
  resourceLabel?: string;
  id?: string;
  itemIndex?: number;
  /** Send the API key. Default true. */
  auth?: boolean;
}

export interface FbResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

interface Connection {
  base: string;
  host: string;
  allowUnauthorizedCerts: boolean;
}

/** A finished exchange; `status` is null when the connection itself failed. */
interface Outcome {
  status: number | null;
  body: unknown;
  headers: Record<string, string>;
  networkCode?: string;
  retryAfterSeconds?: number;
}

type Transfer = Pick<FbRequest, 'method' | 'path' | 'qs' | 'body' | 'idempotencyKey' | 'auth'>;

async function connect(ctx: Ctx): Promise<Connection> {
  const node = ctx.getNode();
  let credentials: IDataObject;
  try {
    credentials = await ctx.getCredentials(CREDENTIAL_NAME);
  } catch {
    // Deliberately not the original error text.
    throw new NodeOperationError(node, 'FeedBouncer credentials are missing. Select a FeedBouncer API credential.');
  }
  const base = normalizeBaseUrl(String(credentials.baseUrl ?? ''), credentials.allowHttp === true);
  if (!base.ok) throw new NodeOperationError(node, base.message);
  return {
    base: base.url,
    host: new URL(base.url).hostname,
    allowUnauthorizedCerts: credentials.allowUnauthorizedCerts === true,
  };
}

const lowerCaseHeaders = (raw: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries((raw ?? {}) as Record<string, unknown>).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value),
    ]),
  );

/** Only the error code is read: the helper's error holds the request config, headers included. */
function networkCodeOf(error: unknown): string {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' ? code : typeof causeCode === 'string' ? causeCode : 'UNKNOWN';
}

async function sendOnce(ctx: Ctx, conn: Connection, req: Transfer): Promise<Outcome> {
  const options: IHttpRequestOptions = {
    method: req.method,
    url: conn.base + req.path,
    qs: req.qs,
    body: req.body,
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    disableFollowRedirect: true,
    timeout: REQUEST_TIMEOUT_MS,
    skipSslCertificateValidation: conn.allowUnauthorizedCerts,
    headers: {
      'User-Agent': `n8n-nodes-feedbouncer/${version}`,
      ...(req.idempotencyKey && { 'Idempotency-Key': req.idempotencyKey }),
    },
  };
  try {
    const response = (await (req.auth === false
      ? ctx.helpers.httpRequest(options)
      : ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_NAME, options))) as {
      statusCode: number;
      headers?: unknown;
      body?: unknown;
    };
    return { status: response.statusCode, body: response.body, headers: lowerCaseHeaders(response.headers) };
  } catch (error) {
    return { status: null, body: undefined, headers: {}, networkCode: networkCodeOf(error) };
  }
}

/** Sends the request, retrying 429s. Never throws for an HTTP status. */
async function transfer(ctx: Ctx, conn: Connection, req: Transfer): Promise<Outcome> {
  for (let retry = 0; ; retry++) {
    const outcome = await sendOnce(ctx, conn, req);
    if (outcome.status !== 429) return outcome;

    const header = Number(outcome.headers['retry-after']);
    const retryAfterSeconds = outcome.headers['retry-after']?.trim() && Number.isFinite(header) && header >= 0 ? header : undefined;
    const waitSeconds = retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS[retry];
    if (retry >= MAX_429_RETRIES || waitSeconds > MAX_RETRY_AFTER_SECONDS) {
      return { ...outcome, retryAfterSeconds };
    }
    await sleep(waitSeconds * 1000);
  }
}

const supportCache = new WeakMap<object, Promise<Set<string> | null>>();

async function fetchOperationIds(ctx: Ctx): Promise<Set<string> | null> {
  const outcome = await transfer(ctx, await connect(ctx), { method: 'GET', path: '/v1/openapi.json', auth: false });
  const paths = (outcome.body as { paths?: unknown } | null | undefined)?.paths;
  if (outcome.status !== 200 || typeof paths !== 'object' || paths === null) return null;
  const ids = new Set<string>();
  for (const item of Object.values(paths)) {
    for (const operation of Object.values((item ?? {}) as Record<string, unknown>)) {
      const id = (operation as { operationId?: unknown } | null)?.operationId;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

/** True when the server's OpenAPI document lists the operation, or when it cannot be read. */
export async function ensureOperationSupported(ctx: Ctx, operationId: string): Promise<boolean> {
  let lookup = supportCache.get(ctx);
  if (!lookup) {
    lookup = fetchOperationIds(ctx);
    supportCache.set(ctx, lookup);
  }
  const ids = await lookup;
  return ids === null || ids.has(operationId);
}

export async function feedBouncerRequest<T>(ctx: Ctx, req: FbRequest): Promise<FbResponse<T>> {
  const conn = await connect(ctx);
  const outcome = await transfer(ctx, conn, req);
  if (outcome.status !== null && outcome.status >= 200 && outcome.status < 300) {
    return { status: outcome.status, body: outcome.body as T, headers: outcome.headers };
  }

  const unsupported =
    outcome.status === 404 && !apiErrorEnvelope(outcome.body) && !(await ensureOperationSupported(ctx, req.operationId));
  const node = ctx.getNode();
  const info = describeFailure({
    status: outcome.status,
    body: outcome.body,
    credentialName: node.credentials?.[CREDENTIAL_NAME]?.name ?? 'FeedBouncer API',
    resourceLabel: req.resourceLabel,
    id: req.id,
    networkCode: outcome.networkCode,
    host: conn.host,
    unsupported,
    retryAfterSeconds: outcome.retryAfterSeconds,
  });
  throw toNodeApiError(node, info, req.itemIndex);
}
