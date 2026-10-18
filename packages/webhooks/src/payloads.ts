import { z } from 'zod';
import {
  CommentResource,
  FlaggedItemResource,
  type WebhookEventType,
} from '@feedbouncer/public-api';

export const HIDE_SOURCES = ['rule', 'classifier', 'policy', 'user', 'api', 'system'] as const;

export const TEST_EVENT_MESSAGE = 'This is a test event from FeedBouncer.';

const envelope = <Type extends string, Data extends z.ZodType>(
  id: string,
  type: Type,
  description: string,
  data: Data,
) =>
  z
    .object({
      id: z.uuid().meta({ description: 'The event id; it is also the `webhook-id` header.' }),
      type: z.literal(type),
      createdAt: z.iso.datetime().meta({ description: 'When the event happened.' }),
      organizationId: z.uuid(),
      data,
    })
    .meta({ id, description });

const Hide = z.object({
  actionId: z.uuid(),
  source: z.enum(HIDE_SOURCES),
  reason: z.string(),
  ruleId: z.uuid().nullable(),
  hiddenAt: z.iso.datetime(),
});

/** What a delivery of each event type carries; the OpenAPI `webhooks` map is built from these. */
export const WEBHOOK_PAYLOAD_SCHEMAS = {
  'comment.received': envelope(
    'CommentReceivedEvent',
    'comment.received',
    'A new comment arrived. `data.comment` is the comment as it is when the delivery is sent.',
    z.object({ comment: CommentResource }),
  ),
  'comment.hidden': envelope(
    'CommentHiddenEvent',
    'comment.hidden',
    'A comment was hidden on its platform. `data.hide` is fixed at the time of the hide.',
    z.object({ comment: CommentResource, hide: Hide }),
  ),
  'item.flagged': envelope(
    'ItemFlaggedEvent',
    'item.flagged',
    'A comment was flagged for review.',
    z.object({ flaggedItem: FlaggedItemResource }),
  ),
  'webhook.test': envelope(
    'WebhookTestEvent',
    'webhook.test',
    'Sent on request to check that an endpoint receives and verifies deliveries.',
    z.object({ endpointId: z.uuid(), message: z.literal(TEST_EVENT_MESSAGE) }),
  ),
} as const satisfies Readonly<Record<WebhookEventType | 'webhook.test', z.ZodObject>>;
