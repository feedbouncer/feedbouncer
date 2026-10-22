---
title: API overview
description: What the public API is, where it lives, how it is versioned and where to find the full reference.
status: stable
---

The public API lets your own systems read comments and flagged items, hide, unhide and reply to comments, check text before you publish it, propose rule changes and receive webhooks. The [MCP tools](../mcp/overview.md) and the n8n node use the same routes.

## Base URL

Every route lives under `/v1` on your web origin. For the examples in these docs, set it once:

```bash
export FEEDBOUNCER_URL=https://feedbouncer.example.com
```

Use the address you open FeedBouncer at. The web app forwards `/v1/*` to the API, so there is no separate host to configure.

Callers inside the same network as a self-hosted instance can also reach the API directly on its own port (3001 unless you changed `PORT`). The routes and responses are identical. Callers outside that network should use the web origin.

## Authentication

Send an API key as a bearer token. See [Authentication](./authentication.md) and the [quickstart](./quickstart.md).

## Versions

The `/v1` in the path is the **API version**. Within it, changes only add: new routes, new optional fields, new [error codes](./errors.mdx) and new reason codes. Nothing is renamed or removed, so ignore fields and codes you do not know.

The API version is not the product version. The product version is the one in the version menu of this site. A new FeedBouncer release can add to `/v1` without changing its number. The API description reports `info.version` `1.0.0`.

## The API description

The machine-readable description is an OpenAPI 3.1 document. A running instance serves it, with no key needed, at `GET /v1/openapi.json`. It always matches the routes of that instance. This site builds its [endpoint reference](./reference/feedbouncer-api.info.mdx) from the same document, and the copy for this version is in the repository.

## What to read next

- [Quickstart](./quickstart.md): your first request.
- [Errors](./errors.mdx), [pagination](./pagination.md), [rate limits](./rate-limits.mdx) and [idempotency](./idempotency.md): how every route behaves.
- [Webhooks](./webhooks.md): receive events and verify them.
- [Moderation check](./moderation-check.md): judge text before you publish it.
