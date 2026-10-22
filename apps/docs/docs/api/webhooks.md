---
title: Webhooks
description: Register an endpoint, receive signed events, verify them, rotate the secret and handle retries.
status: stable
---

A webhook endpoint receives an HTTP `POST` when something happens in your organization, so you do not have to poll. Manage endpoints with a `write` key.

## Registering an endpoint

```bash
curl -sS -X POST "$FEEDBOUNCER_URL/v1/webhook-endpoints" \
  -H "Authorization: Bearer $FEEDBOUNCER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "<RECEIVER_URL>", "eventTypes": ["comment.hidden", "item.flagged"]}'
```

The response holds the endpoint and its signing secret, `whsec_` followed by base64 characters. The secret is shown once, so store it at once. An organization can have 10 endpoints.

| Event type         | Sent when                                                                    |
| ------------------ | ---------------------------------------------------------------------------- |
| `comment.received` | A new comment is ingested.                                                   |
| `comment.hidden`   | A comment is hidden through FeedBouncer.                                     |
| `item.flagged`     | A comment is flagged for review.                                             |
| `webhook.test`     | You ask for it with `POST /v1/webhook-endpoints/<WEBHOOK_ENDPOINT_ID>/test`. |

Choose the events an endpoint receives with `eventTypes`. `webhook.test` is not one of the choices: it goes to the endpoint you test, whatever its `eventTypes`. A hide made in Meta's own interface does not produce `comment.hidden`, and backfilled or own-account comments do not produce `comment.received`.

## Destination rules

The endpoint URL, `<RECEIVER_URL>` above, must use `https` on port 443 and resolve only to public addresses. FeedBouncer checks this when you register the endpoint and again on every delivery, and it never follows redirects. A URL that breaks a rule is refused with `422 invalid_webhook_url`.

Self-hosters that deliver to a receiver on an internal network list it in `WEBHOOK_ALLOWED_PRIVATE_CIDRS`, as comma-separated CIDR ranges. Do this only for networks you trust: it lets anyone who can create endpoints reach them.

## Payloads

Every delivery is a `POST` with a JSON body. This is a `webhook.test` event:

```json
{
  "id": "<EVENT_ID>",
  "type": "webhook.test",
  "createdAt": "2026-10-22T12:00:00.000Z",
  "organizationId": "<ORGANIZATION_ID>",
  "data": {
    "endpointId": "<WEBHOOK_ENDPOINT_ID>",
    "message": "This is a test event from FeedBouncer."
  }
}
```

`id`, `type`, `createdAt` and `organizationId` are on every event. `data` depends on the type: the `comment` for `comment.received`, the `comment` and a `hide` object for `comment.hidden`, and the `flaggedItem` for `item.flagged`. The schemas are listed under webhooks in the [reference](./reference/feedbouncer-api.info.mdx).

The body is built when the delivery is sent. A comment that has since been deleted or erased is never sent, including on redelivery. Delivery history is kept for 30 days.

These headers come with each delivery:

| Header                    | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| `webhook-id`              | The event id. It is the same on every retry.           |
| `webhook-timestamp`       | When this attempt was signed, in Unix seconds.         |
| `webhook-signature`       | One or more `v1,<base64>` signatures, space-separated. |
| `feedbouncer-event-type`  | The event type.                                        |
| `feedbouncer-delivery-id` | The id of this delivery.                               |

## Verifying signatures

Signatures follow the Standard Webhooks format: an HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed with the base64-decoded part of the secret after `whsec_`. The `standardwebhooks` library verifies it for you. Verify the raw request body, before you parse it:

```js
import { Webhook } from 'standardwebhooks';

// The signing secret you stored, which starts with whsec_.
const wh = new Webhook(process.env.FEEDBOUNCER_WEBHOOK_SECRET);

// rawBody is the unparsed string. headers has webhook-id, webhook-timestamp and webhook-signature.
const event = wh.verify(rawBody, headers); // throws if the signature or timestamp is wrong
```

Reject a delivery that fails verification with a `400`. The library also rejects timestamps more than 5 minutes old, which stops a captured delivery being replayed later. Keep the secret out of source code and logs.

## Rotating the secret

`POST /v1/webhook-endpoints/<WEBHOOK_ENDPOINT_ID>/rotate-secret` returns a new secret. For 24 hours each delivery is signed with both the new and the previous secret, and `webhook-signature` holds both signatures. Deploy the new secret within that time and you drop no events. A verifier accepts the delivery if any signature matches.

## Retries and ordering

- **At least once.** The same event can arrive more than once, and events can arrive out of order. De-duplicate on `webhook-id`, and use `createdAt` if order matters.
- **Success** is any `2xx` within 10 seconds. A different status, a timeout, or a connection or TLS error is a failure. Answer quickly and do the work afterwards.
- **Retries.** A failed delivery is tried up to 6 more times, after about 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 12 hours, each varied by 10% either way. That is about 21 hours in all. After the last attempt the delivery is `failed`.
- **Disabling.** An endpoint that fails 20 deliveries in a row over at least 24 hours is disabled, and the organization's owners and admins get an email. Events that happen while it is disabled are not recorded. Re-enable it with `PATCH /v1/webhook-endpoints/<WEBHOOK_ENDPOINT_ID>` and `{"status": "active"}`.
- **History.** `GET /v1/webhook-endpoints/<WEBHOOK_ENDPOINT_ID>/deliveries` shows every attempt. `POST /v1/webhook-endpoints/<WEBHOOK_ENDPOINT_ID>/deliveries/<WEBHOOK_DELIVERY_ID>/redeliver` sends a finished delivery again. While one is still being attempted you get `409 webhook_delivery_in_progress`.
- **Fairness.** One slow receiver cannot hold up others: an endpoint has at most 4 deliveries in flight, and an organization at most 8.
