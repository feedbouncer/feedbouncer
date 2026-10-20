# Public API and webhooks

The reference for every `/v1` route and event payload is [openapi.json](openapi.json), served live at `GET /v1/openapi.json`. This page covers what the reference cannot: how to authenticate, how deliveries behave and how to verify them.

## Authentication

Create an API key in the dashboard (owners and admins only) and send it as a bearer token:

```
Authorization: Bearer fbk_<id>_<secret>
```

- A key belongs to one organization and can only see that organization's brands, comments and flagged items. Asking for another organization's ids, an archived brand or a deleted comment returns `404`. The exception is list filters: `GET /v1/comments?brandId=` with a brand outside the organization returns an empty page.
- Scopes: `read` keys can call every `GET` route except the webhook endpoint ones; `moderate` keys can only call `POST /v1/moderation/check` and `GET /v1/key` (no route reads comments or any other data); `write` keys can also hide, unhide and reply to comments, propose rule changes and manage webhook endpoints. Reading webhook endpoints needs a `write` key because it reveals where events are sent.
- `GET /v1/key` describes the key making the request (`organizationId`, `name`, `scope`). Use it to check a key before doing anything else.
- The secret is shown once and only a hash is stored. Revoking a key takes effect on its next request. Keys keep working after the admin who created them leaves, so revoke them when someone leaves.

## Errors, rate limits and idempotency

- Errors are `{ "error": { "code": "...", "message": "..." } }`. Match on `code`; each route lists its codes and statuses in the reference.
- Each key may make a limited number of requests per minute (`PUBLIC_API_RATE_LIMIT_PER_MINUTE`, default 60). Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Over the limit you get `429 rate_limited` with `Retry-After` in seconds.
- Every route that changes state except `DELETE /v1/webhook-endpoints/{id}` accepts an `Idempotency-Key` header (1 to 128 characters of letters, digits and `. _ : -`). A repeat with the same key and body within 24 hours returns the first response; the same key with a different body is `422 idempotency_key_reused`.

## Comments, replies and moderation

- `GET /v1/comments` lists comments newest first and pages with `cursor`. Filters: `brandId`, `platform` (`facebook`, `instagram`), `status` (`visible`, `hidden`, `flagged`, `replied`, `unanswered`), `postedFrom` (inclusive) and `postedTo` (exclusive), and `q`, a case-insensitive substring (2 to 200 characters) of the comment text or the author name. Filters combine, and a search with no match is an empty page. A cursor keeps the result set it started with, so later pages neither repeat nor skip comments when new ones arrive.
- `POST /v1/comments/{id}/hide` and `/unhide` ask the platform to change a comment's visibility. A comment already in that state answers `200` with action status `noop` and code `already_hidden` or `already_visible`; otherwise the answer is `202` with a `pending` action.
- `POST /v1/comments/{id}/replies` with `{"text": "..."}` posts a public reply as the brand. It answers `202` with a `pending` action that the worker then posts, or `200` when the outcome is known at once. Errors: `422 text_too_long` (with `max`), `422 reply_not_allowed` (with `reason`), `422 unsupported_action`, `409 connection_inactive`. Send an `Idempotency-Key` so a retry cannot post twice.
- `GET /v1/actions/{id}` returns the status of a hide, unhide or reply: `pending`, `applied` (for a reply, `platformRef` is the reply's platform ID), `noop`, `not_eligible` or `failed`, with a `code` for the last three.

## Checking text before you publish it

`POST /v1/moderation/check` judges any text against a brand's rules, classifier and policies and answers `allow`, `review` or `block`. It needs a `moderate`, `read` or `write` key. Nothing is stored in the database and nothing is retained: the text waits in Redis only until the check finishes or times out, then it is deleted. It is not logged. Retention settings do not apply because there is nothing to retain.

```bash
curl -X POST https://api.example.com/v1/moderation/check \
  -H "Authorization: Bearer $FEEDBOUNCER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Buy followers at spam.example", "brandId": "0b8f2f4e-7a0c-4e0a-9a43-6f3a1d9f6c22", "ref": "post-1234"}'
```

```json
{
  "verdict": "block",
  "reasonCode": "rule_matched",
  "reason": "Rule \"Spam links\" (link): spam.example.",
  "decidedBy": "rule",
  "degraded": false,
  "evidence": {
    "ruleId": "6f1c1e0e-5c5b-4f0e-8d57-0a7f0f6d2b11",
    "ruleName": "Spam links",
    "category": null,
    "score": null,
    "threshold": null,
    "policyId": null,
    "policyRevision": null,
    "language": null
  },
  "models": { "classifier": null, "policy": null },
  "brandId": "0b8f2f4e-7a0c-4e0a-9a43-6f3a1d9f6c22",
  "ref": "post-1234",
  "checkedAt": "2026-10-20T15:00:00.000Z"
}
```

- Request: `text` (required), `brandId` (optional when the workspace has exactly one active brand) and `ref` (optional, 1 to 128 printable ASCII characters, echoed back). Unknown fields are rejected.
- Text is at most 4,000 UTF-16 code units, the amount the classifier reads, so nothing is silently cut. It must be valid UTF-8, free of U+0000 and contain a visible character.
- Verdicts: a matching rule decides first (including an approving rule). Otherwise the more severe of the classifier and policy outcomes wins; with no match the verdict is `allow`.
- `reasonCode` is one of `rule_matched`, `classifier_threshold`, `policy_matched`, `no_match`, `classifier_unavailable`, `classifier_not_configured`, `policy_unavailable`. Codes are only ever added, never renamed. Match on them rather than on `reason`.
- A check that could not fully run is never `allow`: you get `review`, `degraded: true` and the matching `*_unavailable` or `classifier_not_configured` code (an instance without a classifier holds every text no rule decided).
- Errors: `400 invalid_request` (bad body, text that is not well-formed or has no visible characters, missing `brandId`), `401`, `403 insufficient_scope`, `404 not_found` (unknown or archived brand, or one of another organization), `413`, `422 text_too_long` (with `maxLength`), `429 rate_limited` and `503 temporarily_unavailable` with `Retry-After: 5` when the worker did not answer in time (`MODERATION_CHECK_TIMEOUT_MS`, default 20000). A retry is always safe.
- The usual per-key rate limit applies (`PUBLIC_API_RATE_LIMIT_PER_MINUTE`, default 60). Policy checks made through this route count against the brand's monthly policy-check budget and its concurrent policy-call limit, like connected comments do. When either is exhausted the answer is `review` with `reasonCode: "policy_unavailable"` and `degraded: true`, never `allow`.

## Summaries

`GET /v1/summary?from=&to=&brandId=` returns totals (comments, hidden, replied, unanswered), categories, the rules that matched most and the threads with the most replies. `to` (exclusive) defaults to now and `from` (inclusive) to 7 days before it. A longer period than 92 days is cut to its last 92 days and `bounded` says so. `to` before `from` or in the future is `400 invalid_request` with `reason` `to_before_from` or `to_in_future`.

## Rules and rule-change proposals

- `GET /v1/rules` lists the live rules of every brand (or of `brandId`) with the brand's `ruleRevision` and the rule-change proposals of the last 7 days. It changes nothing.
- `POST /v1/rule-change-proposals` proposes creating, updating or archiving a rule: `{"brandId", "operation": "create", "rule": {...}}`, `{"brandId", "operation": "update", "ruleId", "patch": {...}}` or `{"brandId", "operation": "archive", "ruleId"}`, each with an optional `rationale`. It answers `201` with a `pending` proposal, its `diff`, `warnings`, `expiresAt` and the `reviewUrl` of its page in the web app. No rule changes until a person approves it there; no API route approves. The same change while one is pending answers `200` with the waiting proposal.
- A proposal that could never be applied is `422 rule_rejected` with a `reason` (`invalid_rule`, `matches_everything`, `duplicate_of_rule`, `conflicts_with_rule`, `step_not_allowed_via_api`, `no_change`) and, for a duplicate or conflict, the other rule's `ruleId`. A brand with 200 rules gets `409 rule_limit_reached`, and one with 20 pending proposals `409 pending_limit_reached`.
- Proposals expire after `RULE_PROPOSAL_TTL_HOURS` (default 24). How they are approved, and why they go stale: [docs/mcp/approval.md](../mcp/approval.md).

The MCP server in `apps/mcp` wraps these routes as tools for MCP clients: see [docs/mcp](../mcp/README.md).

The n8n community node in integrations/n8n-nodes-feedbouncer wraps these routes and webhooks for n8n: see its [README](../../integrations/n8n-nodes-feedbouncer/README.md).

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
