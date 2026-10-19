# Public API and webhooks

The reference for every `/v1` route and event payload is [openapi.json](openapi.json), served live at `GET /v1/openapi.json`. This page covers what the reference cannot: how to authenticate, how deliveries behave and how to verify them.

## Authentication

Create an API key in the dashboard (owners and admins only) and send it as a bearer token:

```
Authorization: Bearer fbk_<id>_<secret>
```

- A key belongs to one organization and can only see that organization's brands, comments and flagged items. Asking for another organization's ids, an archived brand or a deleted comment returns `404`.
- Scopes: `read` keys can call every `GET` route; `write` keys can also hide, flag and manage webhook endpoints. Reading webhook endpoints needs a `write` key because it reveals where events are sent.
- The secret is shown once and only a hash is stored. Revoking a key takes effect on its next request. Keys keep working after the admin who created them leaves, so revoke them when someone leaves.

## Errors, rate limits and idempotency

- Errors are `{ "error": { "code": "...", "message": "..." } }`. Match on `code`; each route lists its codes and statuses in the reference.
- Each key may make a limited number of requests per minute (`PUBLIC_API_RATE_LIMIT_PER_MINUTE`, default 60). Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Over the limit you get `429 rate_limited` with `Retry-After` in seconds.
- Routes that change state accept an `Idempotency-Key` header (1 to 128 characters of letters, digits and `. _ : -`). A repeat with the same key and body within 24 hours returns the first response; the same key with a different body is `422 idempotency_key_reused`.

## Webhook endpoints

Register an endpoint with `POST /v1/webhook-endpoints`. The response contains the signing secret (`whsec_...`) once; store it.

Event types: `comment.received`, `comment.hidden`, `item.flagged`, and `webhook.test`, which `POST /v1/webhook-endpoints/{id}/test` sends on request. Choose the ones an endpoint receives with `eventTypes` when you register it.

Hides made in Meta's own interface do not produce `comment.hidden`, and backfilled or own-account comments do not produce `comment.received`.

### Destination rules

Endpoint URLs must be `https` on port 443 and resolve only to public addresses. The check runs when you register the endpoint and again on every delivery, and redirects are never followed. Self-hosters that deliver to an internal receiver list its network in `WEBHOOK_ALLOWED_PRIVATE_CIDRS` (comma-separated CIDR ranges). Only do this for networks you trust: it lets anyone who can create endpoints reach them.

### Payloads

Every delivery is a `POST` with a JSON body:

```json
{
  "id": "5c4b1c3e-...",
  "type": "comment.hidden",
  "createdAt": "2026-10-18T12:00:00.000Z",
  "organizationId": "a1b2c3d4-...",
  "data": { "comment": {}, "hide": {} }
}
```

The schema of each type is under `webhooks` in the reference. The body is built when the delivery is sent, so a comment that has since been deleted or erased is never sent, including on redelivery. Delivery history is kept for 30 days.

Headers: `webhook-id` (the event id, the same on every retry), `webhook-timestamp`, `webhook-signature`, `feedbouncer-event-type` and `feedbouncer-delivery-id`.

### Verifying signatures

Signatures follow the [Standard Webhooks](https://www.standardwebhooks.com) format (HMAC-SHA256 over `id.timestamp.body`), so the `standardwebhooks` library verifies them. Verify the raw request body, before parsing it:

```js
import { Webhook } from 'standardwebhooks';

const wh = new Webhook(process.env.FEEDBOUNCER_WEBHOOK_SECRET); // the whsec_... value
// headers: webhook-id, webhook-timestamp, webhook-signature; rawBody: the unparsed string
const event = wh.verify(rawBody, headers);
```

Reject deliveries whose timestamp is more than 5 minutes old. `webhook-signature` can hold several space-separated signatures while a secret is being rotated.

### Rotating the secret

`POST /v1/webhook-endpoints/{id}/rotate-secret` returns a new secret. For 24 hours deliveries are signed with both the new and the previous secret, so you can deploy the new one without dropping events.

### Delivery, retries and ordering

- Delivery is at least once: the same event can arrive more than once, and events can arrive out of order. De-duplicate on `webhook-id`.
- Any `2xx` within 10 seconds is a success. Anything else (other status, timeout, connection or TLS error) is a failure.
- A failed delivery is retried up to 6 more times, after about 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 12 hours (each varied by 10% either way), roughly 21 hours in total. After the last attempt it is marked `failed`.
- An endpoint that fails 20 deliveries in a row over at least 24 hours is disabled and the organization's owners and admins are emailed. Events that occur while it is disabled are not recorded. Re-enable it with `PATCH /v1/webhook-endpoints/{id}` and `{"status":"active"}`.
- `GET /v1/webhook-endpoints/{id}/deliveries` shows each attempt's outcome. `POST .../deliveries/{deliveryId}/redeliver` sends a finished delivery again; while it is still being attempted you get `409 webhook_delivery_in_progress`.
- One slow or failing receiver cannot delay others: each endpoint has at most 4 deliveries in flight and each organization at most 8.
