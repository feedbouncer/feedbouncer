import type { INodeProperties } from 'n8n-workflow';

const forDecision = { resource: ['decision'] };

export const decisionDescription: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: forDecision },
    options: [
      { name: 'Hide', value: 'hide', action: 'Hide a comment', description: 'Hide a comment on its platform' },
      {
        name: 'Undo Hide',
        value: 'undoHide',
        action: 'Undo the hide of a comment',
        description: 'Make a hidden comment visible again',
      },
    ],
    default: 'hide',
  },
  {
    displayName: 'Comment ID',
    name: 'commentId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: forDecision },
    description: 'The FeedBouncer ID of the comment',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: { show: forDecision },
    options: [
      {
        displayName: 'Idempotency Key',
        name: 'idempotencyKey',
        type: 'string',
        default: '',
        description:
          'Sent as the Idempotency-Key header. Leave empty to derive one from the execution, node and item, which protects retries within one execution (Retry On Fail). Retrying a failed execution from the executions list is a new execution; set a fixed key to protect that too.',
      },
      {
        displayName: 'Wait for Result',
        name: 'waitForResult',
        type: 'boolean',
        default: true,
        description: 'Whether to wait up to 15 seconds for the platform to confirm the change',
      },
    ],
  },
];
