---
title: Self-hosting
description: FeedBouncer runs the same code self-hosted and in the cloud. What differs is who operates it.
status: stable
---

The same code runs self-hosted and in the cloud. A self-hosted instance has the same rules and API, and the MCP server connects to it the same way. You operate it, so you also set the things the cloud operator would set.

## What you operate

- The services and database, started with Docker Compose.
- Your own Meta app, for Facebook Pages and optional Instagram. Follow the <RepoLink path="docs/self-hosting/meta-app.md">Meta app guide</RepoLink>.
- Secrets and encryption keys.
- The model provider for the <Term id="classifier">classifier</Term> and <Term id="policy">policies</Term>, if you want them.
- <RepoLink path="docs/operations/data-retention.md">Data retention</RepoLink> for your deployment.

## Your public address

Set `PUBLIC_WEB_URL` to the public origin of your instance. The API is reachable at that origin under `/v1`. In the API and MCP examples in these docs, `FEEDBOUNCER_URL` is your `PUBLIC_WEB_URL` origin, for example `https://feedbouncer.example.com`.

Review mode, the <Term id="rule">rule</Term> engine and the retention settings behave the same as in the cloud.
