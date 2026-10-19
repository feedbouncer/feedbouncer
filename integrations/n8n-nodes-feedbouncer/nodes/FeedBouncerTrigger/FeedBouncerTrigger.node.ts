import { NodeConnectionTypes } from 'n8n-workflow';
import type { IDataObject, IHookFunctions, INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { CREDENTIAL_NAME } from '../shared/constants';
import { rememberEvent } from './dedupe';
import { checkExists, create, remove } from './lifecycle';
import type { TriggerStaticData } from './lifecycle';
import { verifySignature } from './signature';

export class FeedBouncerTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'FeedBouncer Trigger',
    name: 'feedBouncerTrigger',
    icon: { light: 'file:feedbouncer.svg', dark: 'file:feedbouncer.dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description: 'Starts a workflow when FeedBouncer flags, hides or receives a comment',
    defaults: { name: 'FeedBouncer Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL_NAME, required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
    properties: [
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        options: [
          { name: 'Comment Flagged for Review', value: 'item.flagged' },
          { name: 'Comment Hidden', value: 'comment.hidden' },
          { name: 'Comment Received', value: 'comment.received' },
        ],
        default: ['item.flagged'],
        description: 'Which FeedBouncer events start the workflow',
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions) {
        return checkExists.call(this);
      },
      async create(this: IHookFunctions) {
        return create.call(this);
      },
      async delete(this: IHookFunctions) {
        return remove.call(this);
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const reject = (status: number, error: string): IWebhookResponseData => {
      this.getResponseObject().status(status).json({ error });
      return { noWebhookResponse: true };
    };

    const { rawBody } = this.getRequestObject();
    if (!Buffer.isBuffer(rawBody)) return reject(401, 'invalid_signature');

    const data = this.getWorkflowStaticData('node') as TriggerStaticData;
    const headers = this.getHeaderData();
    const header = (name: string) => (typeof headers[name] === 'string' ? headers[name] : undefined);
    const id = header('webhook-id');

    const verified = verifySignature({
      secret: data.secret,
      id,
      timestamp: header('webhook-timestamp'),
      signatureHeader: header('webhook-signature'),
      rawBody,
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (!verified.ok || !id) return reject(401, 'invalid_signature');

    let event: IDataObject;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return reject(400, 'invalid_body');
      event = parsed as IDataObject;
    } catch {
      return reject(400, 'invalid_body');
    }

    const selected = this.getNodeParameter('events', []) as string[];
    if (event.type === 'webhook.test' || typeof event.type !== 'string' || !selected.includes(event.type)) {
      return { webhookResponse: 'ok' };
    }
    if (!rememberEvent(data, id, Date.now())) return { webhookResponse: 'ok' };

    return { workflowData: [[{ json: { ...event, deliveryId: header('feedbouncer-delivery-id') ?? null } }]] };
  }
}
