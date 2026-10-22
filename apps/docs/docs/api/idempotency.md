---
title: Idempotency
description: Make retries of routes that change state safe with the Idempotency-Key header.
status: stable
---

If a request times out, you cannot tell whether it ran. Send an `Idempotency-Key` so that retrying it cannot do it twice. The routes that accept it include replying to a comment, hiding and unhiding, proposing a rule change, and creating, updating, rotating and testing webhook endpoints. `DELETE /v1/webhook-endpoints/{id}` does not accept it. Each route's reference page shows the header.

## The key

```bash
curl -sS -X POST "$FEEDBOUNCER_URL/v1/comments/<COMMENT_ID>/replies" \
  -H "Authorization: Bearer $FEEDBOUNCER_API_KEY" \
  -H "Idempotency-Key: reply-<COMMENT_ID>-1" \
  -H "Content-Type: application/json" \
  -d '{"text": "Thanks for the feedback!"}'
```

A key is 1 to 128 characters from `A-Z a-z 0-9 . _ : -`. Anything else is `400 invalid_idempotency_key`. Make a new key per intended action, for example a random UUID or an id of your own, and reuse it only to retry that same action.

## Replay

A repeat of the same request with the same key within 24 hours returns the first response, with the same status and body, plus:

```http
Idempotent-Replayed: true
```

The request does not run again. The first response is kept for 24 hours from when it was made. Client errors (4xx) are kept too, so a repeat of a rejected request gets the same rejection. Server errors (5xx) are not kept, so a retry after one runs the request.

Keys are per API key: another key can use the same string without clashing.

## Conflicts

| Answer                                | Meaning                                                | What to do                                       |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `422 idempotency_key_reused`          | The key was used with a different route, path or body. | Use a new key for the new request. Do not retry. |
| `409 idempotency_request_in_progress` | The first request with this key has not finished.      | Wait a moment, then send the same request again. |

Match "the same request" by route, path parameters and body. Headers other than the key do not count.
