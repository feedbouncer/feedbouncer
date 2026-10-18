import { z } from 'zod';

export const WEBHOOK_EVENT_TYPES = ['comment.received', 'comment.hidden', 'item.flagged'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const DELIVERY_STATUSES = [
  'pending',
  'sending',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const WebhookEndpointResource = z
  .object({
    id: z.uuid(),
    url: z.string(),
    description: z.string().nullable(),
    eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
    status: z.enum(['active', 'disabled']),
    disabledReason: z.enum(['consecutive_failures', 'manual']).nullable(),
    disabledAt: z.iso.datetime().nullable(),
    rotationOverlapUntil: z.iso.datetime().nullable().meta({
      description:
        'While set and in the future, deliveries are signed with the previous secret too.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'WebhookEndpoint' });
export type WebhookEndpointOut = z.output<typeof WebhookEndpointResource>;

export const WebhookDeliveryResource = z
  .object({
    id: z.uuid(),
    eventId: z
      .uuid()
      .meta({ description: 'The `webhook-id` header and payload `id` of the event.' }),
    eventType: z.string(),
    kind: z.enum(['event', 'test', 'redelivery']),
    status: z.enum(DELIVERY_STATUSES),
    attempts: z.number().int(),
    lastAttemptAt: z.iso.datetime().nullable(),
    lastResponseStatus: z.number().int().nullable(),
    lastErrorCode: z.string().nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
    succeededAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WebhookDelivery' });
export type DeliveryOut = z.output<typeof WebhookDeliveryResource>;
