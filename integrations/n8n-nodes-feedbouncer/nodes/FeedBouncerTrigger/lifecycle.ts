import { NodeOperationError } from 'n8n-workflow';
import type { IHookFunctions, IWebhookFunctions } from 'n8n-workflow';
import { CREDENTIAL_NAME, DEFAULT_LIMIT } from '../shared/constants';
import { toNodeApiError } from '../shared/errors';
import { isUuid } from '../shared/ids';
import { collectPages } from '../shared/pagination';
import { feedBouncerRequest } from '../shared/transport';
import { openSecret, sealSecret } from './secretBox';
import { isValidSecret } from './signature';

export interface TriggerStaticData {
  endpointId?: string;
  /** The signing secret, encrypted under the API key; see secretBox. */
  sealedSecret?: string;
  url?: string;
  events?: string[];
  /** The endpoint of a running test listen, kept apart so the production fields stay intact. */
  test?: { endpointId: string; sealedSecret: string; url: string };
  /** Delivery ids already handled, with the time they were seen. */
  seen?: Record<string, number>;
}

const MAX_DESCRIPTION_LENGTH = 500;

interface WebhookEndpoint {
  id: string;
  url: string;
  status: string;
}

const staticData = (ctx: IHookFunctions | IWebhookFunctions) => ctx.getWorkflowStaticData('node') as TriggerStaticData;
const webhookUrl = (ctx: IHookFunctions) => ctx.getNodeWebhookUrl('default') as string;
const events = (ctx: IHookFunctions) => ctx.getNodeParameter('events') as string[];

/**
 * The signing secret of the production endpoint, or of the test-listen endpoint when `forTestListen` is set.
 * Undefined when none is stored or the API key changed since it was sealed.
 */
export async function readSigningSecret(ctx: IHookFunctions | IWebhookFunctions, forTestListen = false): Promise<string | undefined> {
  const { apiKey } = await ctx.getCredentials(CREDENTIAL_NAME);
  const data = staticData(ctx);
  const sealed = forTestListen ? data.test?.sealedSecret : data.sealedSecret;
  return typeof apiKey === 'string' ? openSecret(sealed, apiKey) : undefined;
}

const isStatus = (error: unknown, status: number) => (error as { httpCode?: unknown } | null)?.httpCode === String(status);
const hasApiCode = (error: unknown, code: string) =>
  (error as { context?: { code?: unknown } } | null)?.context?.code === code;

async function deleteEndpoint(ctx: IHookFunctions, id: string): Promise<void> {
  try {
    await feedBouncerRequest(ctx, {
      method: 'DELETE',
      path: `/v1/webhook-endpoints/${encodeURIComponent(id)}`,
      operationId: 'deleteWebhookEndpoint',
      resourceLabel: 'webhook endpoint',
      id,
    });
  } catch (error) {
    // Already a NodeApiError from the request layer.
    // eslint-disable-next-line @n8n/community-nodes/require-node-api-error
    if (!isStatus(error, 404)) throw error;
  }
}

/**
 * Deletes any endpoint registered for exactly this URL, plus the stored one when `replaceStored` is set, so a changed
 * WEBHOOK_URL leaves no orphan while a test listen keeps the production endpoint. Ids that are not UUIDs are skipped.
 */
async function cleanup(ctx: IHookFunctions, url: string, replaceStored: boolean): Promise<void> {
  const all = await collectPages<WebhookEndpoint>(
    async (cursor, limit) =>
      (
        await feedBouncerRequest<{ data: WebhookEndpoint[]; nextCursor: string | null }>(ctx, {
          method: 'GET',
          path: '/v1/webhook-endpoints',
          qs: { limit, ...(cursor && { cursor }) },
          operationId: 'listWebhookEndpoints',
        })
      ).body,
    { returnAll: true, limit: DEFAULT_LIMIT },
  );
  const stored = staticData(ctx);
  const ids = new Set([
    ...all.filter((endpoint) => endpoint.url === url).map((endpoint) => endpoint.id),
    ...(replaceStored ? [stored.endpointId] : []),
  ]);
  for (const id of ids) if (isUuid(id)) await deleteEndpoint(ctx, id);
}

export async function checkExists(this: IHookFunctions): Promise<boolean> {
  const data = staticData(this);
  const url = webhookUrl(this);
  const wanted = [...events(this)].sort();
  if (!isUuid(data.endpointId) || !(await readSigningSecret(this)) || data.url !== url) return false;
  if (JSON.stringify([...(data.events ?? [])].sort()) !== JSON.stringify(wanted)) return false;

  try {
    const { body } = await feedBouncerRequest<WebhookEndpoint>(this, {
      method: 'GET',
      path: `/v1/webhook-endpoints/${encodeURIComponent(data.endpointId)}`,
      operationId: 'getWebhookEndpoint',
      resourceLabel: 'webhook endpoint',
      id: data.endpointId,
    });
    return body.status === 'active' && body.url === url;
  } catch (error) {
    if (isStatus(error, 404)) return false;
    // Already a NodeApiError from the request layer.
    // eslint-disable-next-line @n8n/community-nodes/require-node-api-error
    throw error;
  }
}

/** Messages here are plain strings: the API's own text and the secret never reach them. */
function createFailure(ctx: IHookFunctions, error: unknown, url: string): unknown {
  if (isStatus(error, 422) && hasApiCode(error, 'invalid_webhook_url')) {
    return toNodeApiError(ctx.getNode(), {
      httpCode: 422,
      code: 'invalid_webhook_url',
      message: `FeedBouncer can only deliver to a public https:// address on port 443, and this n8n webhook URL is ${url}.`,
      description:
        "Set n8n's public webhook URL (WEBHOOK_URL) to such an address, or ask your FeedBouncer operator to allow your network in WEBHOOK_ALLOWED_PRIVATE_CIDRS.",
    });
  }
  if (isStatus(error, 409) && hasApiCode(error, 'webhook_endpoint_limit_reached')) {
    return toNodeApiError(ctx.getNode(), {
      httpCode: 409,
      code: 'webhook_endpoint_limit_reached',
      message: 'This FeedBouncer workspace already has 10 webhook endpoints.',
      description: 'Deactivate another FeedBouncer Trigger workflow or delete unused endpoints in FeedBouncer.',
    });
  }
  return error;
}

export async function create(this: IHookFunctions): Promise<boolean> {
  const url = webhookUrl(this);
  const eventTypes = events(this);
  const isTestListen = this.getActivationMode() === 'manual';
  await cleanup(this, url, !isTestListen);

  const description = `n8n workflow ${this.getWorkflow().id}, node "${this.getNode().name}"`
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, MAX_DESCRIPTION_LENGTH);
  let created: { endpoint?: { id: string }; secret: string };
  try {
    ({ body: created } = await feedBouncerRequest<typeof created>(this, {
      method: 'POST',
      path: '/v1/webhook-endpoints',
      body: { url, eventTypes, description },
      operationId: 'createWebhookEndpoint',
    }));
  } catch (error) {
    throw createFailure(this, error, url);
  }

  const endpointId = created.endpoint?.id;
  if (!isUuid(endpointId) || !isValidSecret(created.secret)) {
    // Without a usable id and secret no delivery could be verified: remove the endpoint again.
    if (isUuid(endpointId)) await deleteEndpoint(this, endpointId).catch(() => undefined);
    throw new NodeOperationError(this.getNode(), 'FeedBouncer returned an invalid webhook endpoint response.', {
      description: 'The trigger was not activated. Check that the FeedBouncer server is up to date, then try again.',
    });
  }

  const { apiKey } = await this.getCredentials(CREDENTIAL_NAME);
  const sealedSecret = sealSecret(created.secret, String(apiKey));
  if (isTestListen) staticData(this).test = { endpointId, sealedSecret, url };
  else Object.assign(staticData(this), { endpointId, sealedSecret, url, events: eventTypes });
  return true;
}

/**
 * Never throws: a failed cleanup is retried by the next activation. A test listen only removes endpoints for its own
 * URL and leaves the stored production endpoint and secret untouched.
 */
export async function remove(this: IHookFunctions): Promise<boolean> {
  const data = staticData(this);
  const url = webhookUrl(this);
  const isTestListen = this.getActivationMode() === 'manual';
  try {
    await cleanup(this, isTestListen ? url : (data.url ?? url), !isTestListen);
  } catch {
    // Deliberately ignored.
  }
  if (isTestListen) {
    delete data.test;
    return true;
  }
  delete data.endpointId;
  delete data.sealedSecret;
  delete data.url;
  delete data.events;
  return true;
}
