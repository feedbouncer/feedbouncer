import { NodeConnectionTypes } from 'n8n-workflow';
import type { IHookFunctions, INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { CREDENTIAL_NAME } from '../shared/constants';
import { checkExists, create, remove } from './lifecycle';

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

  // Placeholder until deliveries are verified and emitted.
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    this.getResponseObject().status(501).end();
    return { noWebhookResponse: true };
  }
}
