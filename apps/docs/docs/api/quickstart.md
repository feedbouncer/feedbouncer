---
title: API quickstart
description: Create an API key, make a first request and read the two errors you are most likely to meet.
status: stable
---

This takes about two minutes. You need to be an owner or admin of an organization.

## 1. Create a key

In the web app, open your organization and choose **API keys**, then **Create key**. Give it a name and a [scope](./authentication.md#scopes). Pick `read` for this guide. The key is shown once. Copy it now: only a hash is stored.

## 2. Set two variables

```bash
export FEEDBOUNCER_URL=https://feedbouncer.example.com
export FEEDBOUNCER_API_KEY=<paste the key here>
```

Use your own address for `FEEDBOUNCER_URL`. Keep the key out of scripts and shell history where you can: see [Storing keys](./authentication.md#storing-keys).

## 3. Ask who you are

```bash
curl -sS "$FEEDBOUNCER_URL/v1/key" \
  -H "Authorization: Bearer $FEEDBOUNCER_API_KEY"
```

`GET /v1/key` describes the key making the request, and every scope may call it. Use it to check a key before anything else:

```json
{
  "organizationId": "<ORGANIZATION_ID>",
  "name": "Reporting",
  "scope": "read"
}
```

The response also carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. See [Rate limits](./rate-limits.mdx).

## 4. Read your first page

```bash
curl -sS "$FEEDBOUNCER_URL/v1/comments?limit=5" \
  -H "Authorization: Bearer $FEEDBOUNCER_API_KEY"
```

The answer is `{ "data": [...], "nextCursor": ... }`. [Pagination](./pagination.md) shows how to continue.

## Reading a 401

```bash
curl -sS -i "$FEEDBOUNCER_URL/v1/key" -H "Authorization: Bearer wrong"
```

```text
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer realm="FeedBouncer API"
```

```json
{ "error": { "code": "unauthenticated", "message": "Sign in to continue." } }
```

`unauthenticated` means the key is missing, malformed, unknown or revoked. The same answer covers all four, so a caller cannot tell which keys exist. Check the `Authorization: Bearer` header and the key itself.

## Reading a 403

A valid key without enough scope gets `403 insufficient_scope`. A `moderate` key calling `GET /v1/comments` is an example:

```json
{
  "error": {
    "code": "insufficient_scope",
    "message": "This API key does not have the scope this request needs."
  }
}
```

Create a key with a higher scope. You cannot raise the scope of an existing key.

## Next

[Errors](./errors.mdx) lists every code. The [reference](./reference/feedbouncer-api.info.mdx) lists every route, with a copy-paste `curl` for each.
