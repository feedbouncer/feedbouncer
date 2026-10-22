---
title: Authentication
description: The API key format, scopes, the 401 challenge, and how to store and rotate keys.
status: stable
---

Every route except `GET /v1/openapi.json` needs an API key, sent as a bearer token:

```http
Authorization: Bearer fbk_<16 characters>_<43 characters>
```

The API never reads cookies. A browser session does not authenticate API calls.

## Creating keys

Owners and admins create keys under **API keys** in the organization. A key belongs to one organization and sees only that organization's brands, comments and flagged items. Asking for another organization's id, an archived brand or a deleted comment returns `404 not_found`. The one exception is a list filter: `GET /v1/comments?brandId=` with a brand outside the organization returns an empty page.

## Key format

A key is `fbk_`, then 16 lowercase letters or digits 2 to 7 (the public id), then `_`, then 43 characters of URL-safe base64 (the secret). A string that does not match this shape is rejected as `unauthenticated` without a lookup.

The secret is shown once, and only a hash is stored. FeedBouncer cannot show a key again.

## Scopes

Each key has one scope. Scopes are ordered, and a higher scope can do everything a lower one can.

| Scope      | Order   | Can call                                                                                                                                                 |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moderate` | lowest  | `POST /v1/moderation/check` and `GET /v1/key`. No route reads comments or other data.                                                                    |
| `read`     | middle  | Everything `moderate` can, plus every other `GET` route except webhook endpoints.                                                                        |
| `write`    | highest | Everything `read` can, plus hiding, unhiding and replying to comments, proposing rule changes, and every webhook endpoint route, including reading them. |

Reading webhook endpoints needs `write` because an endpoint's address reveals where events are sent. A key can only be as powerful as its scope: give a service the lowest scope that covers its calls.

## The 401 challenge

A missing, malformed, unknown or revoked key gets `401 unauthenticated` with a challenge header:

```http
WWW-Authenticate: Bearer realm="FeedBouncer API"
```

A valid key with too low a scope gets `403 insufficient_scope`. See [Errors](./errors.mdx).

Repeated failures from one address are limited. See [Rate limits](./rate-limits.mdx#failed-authentication).

## Storing keys

- Keep keys in a secret manager or an environment variable, not in source code, a shared config file or a chat message.
- Never put a key in a URL or in client-side code. Call the API from your server.
- Use one key per integration, named after it, so you can revoke one without breaking the others.
- If a key leaks, revoke it at once. Revocation takes effect on the key's next request.

Keys keep working after the admin who created them leaves the organization. Revoke or replace them when someone leaves.

## Rotating a key

There is no in-place rotation. To rotate:

1. Create a new key with the same scope.
2. Deploy it to the integration.
3. Check it with `GET /v1/key`.
4. Revoke the old key.

Both keys work in between, so nothing is dropped.
