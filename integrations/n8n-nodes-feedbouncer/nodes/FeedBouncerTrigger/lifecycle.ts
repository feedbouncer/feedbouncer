import type { IHookFunctions } from 'n8n-workflow';
import { DEFAULT_LIMIT } from '../shared/constants';
import { toNodeApiError } from '../shared/errors';
import { collectPages } from '../shared/pagination';
import { feedBouncerRequest } from '../shared/transport';

export interface TriggerStaticData {
  endpointId?: string;
  secret?: string;
  url?: string;
  events?: string[];
  /** Delivery ids already handled, with the time they were seen. */
  seen?: Record<string, number>;
}

export const TRIGGER_EVENTS = ['item.flagged', 'comment.hidden', 'comment.received'] as const;

const MAX_DESCRIPTION_LENGTH = 500;

interface WebhookEndpoint {
  id: string;
  url: string;
  status: string;
}

const staticData = (ctx: IHookFunctions) => ctx.getWorkflowStaticData('node') as TriggerStaticData;
const webhookUrl = (ctx: IHookFunctions) => ctx.getNodeWebhookUrl('default') as string;
const events = (ctx: IHookFunctions) => ctx.getNodeParameter('events') as string[];

const isStatus = (error: unknown, status: number) => (error as { httpCode?: unknown } | null)?.httpCode === String(status);

async function deleteEndpoint(ctx: IHookFunctions, id: string): Promise<void> {
  try {
    await feedBouncerRequest(ctx, {
      method: 'DELETE',
      path: `/v1/webhook-endpoints/${id}`,
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

/** Deletes the stored endpoint and any endpoint registered for exactly this node's URL. */
async function cleanup(ctx: IHookFunctions, url: string): Promise<void> {
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
  const ids = new Set(all.filter((endpoint) => endpoint.url === url).map((endpoint) => endpoint.id));
  const { endpointId } = staticData(ctx);
  if (endpointId) ids.add(endpointId);
  for (const id of ids) await deleteEndpoint(ctx, id);
}

export async function checkExists(this: IHookFunctions): Promise<boolean> {
  const data = staticData(this);
  const url = webhookUrl(this);
  const wanted = [...events(this)].sort();
  if (!data.endpointId || !data.secret || data.url !== url) return false;
  if (JSON.stringify([...(data.events ?? [])].sort()) !== JSON.stringify(wanted)) return false;

  try {
    const { body } = await feedBouncerRequest<WebhookEndpoint>(this, {
      method: 'GET',
      path: `/v1/webhook-endpoints/${data.endpointId}`,
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
  if (isStatus(error, 422)) {
    return toNodeApiError(ctx.getNode(), {
      httpCode: 422,
      code: 'invalid_webhook_url',
      message: `FeedBouncer can only deliver to a public https:// address on port 443, and this n8n webhook URL is ${url}.`,
      description:
        "Set n8n's public webhook URL (WEBHOOK_URL) to such an address, or ask your FeedBouncer operator to allow your network in WEBHOOK_ALLOWED_PRIVATE_CIDRS.",
    });
  }
  if (isStatus(error, 409)) {
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
  await cleanup(this, url);

  const description = `n8n workflow ${this.getWorkflow().id}, node "${this.getNode().name}"`
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, MAX_DESCRIPTION_LENGTH);
  let created: { endpoint: { id: string }; secret: string };
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

  Object.assign(staticData(this), { endpointId: created.endpoint.id, secret: created.secret, url, events: eventTypes });
  return true;
}

/** Never throws: a failed cleanup is retried by the next activation. */
export async function remove(this: IHookFunctions): Promise<boolean> {
  const data = staticData(this);
  try {
    await cleanup(this, data.url ?? webhookUrl(this));
  } catch {
    // Deliberately ignored.
  }
  delete data.endpointId;
  delete data.secret;
  delete data.url;
  delete data.events;
  return true;
}
