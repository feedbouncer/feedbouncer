---
title: Prerequisites
description: What you need before you add the FeedBouncer MCP server to a client.
status: stable
---

## Node.js 24

The server needs Node.js 24. Check it with `node --version`. Get Node from [nodejs.org](https://nodejs.org).

## A built checkout

The server is built from the FeedBouncer repository. From a checkout, install and build it with its dependencies:

```bash
pnpm install
pnpm turbo run build --filter=@feedbouncer/mcp...
```

This writes `apps/mcp/dist/main.js`. Clients need its absolute path, shown in these pages as `<REPO_DIR>/apps/mcp/dist/main.js`. Replace `<REPO_DIR>` with the folder you cloned into.

To confirm the build, run `node <REPO_DIR>/apps/mcp/dist/main.js` with no key set. It should stop at once with `FEEDBOUNCER_API_KEY is missing or malformed`.

## An API key

Owners and admins create keys on the organization page, under **API keys**. Pick the <Term id="scope">scope</Term>:

- `read` is enough for `list_inbox`, `search_inbox`, `summarize_period` and `read_rules`.
- `write` is also needed for `reply_to_comment`, `set_comment_visibility` and `propose_rule_change`. A read key gets "This API key is read-only" from those tools.

The key is shown once. Its shape is `fbk_<16 characters>_<43 characters>`. It acts for the whole workspace, so treat it like a password. See [authentication](authentication.mdx).

## Network access

The machine that runs the client must reach your FeedBouncer address, the value you set as `FEEDBOUNCER_API_URL`. It must use `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, which is how a local Docker Compose stack is reached.
