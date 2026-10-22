---
title: Any stdio MCP client
description: The command and environment any MCP client needs to start the FeedBouncer server over stdio.
status: stable
---

## Before you start

Complete the [prerequisites](../prerequisites.md). Any MCP client that can launch a local stdio server can use FeedBouncer. This page lists what to give it.

## Add FeedBouncer

Register a server named `feedbouncer` that runs this command:

```bash
node <REPO_DIR>/apps/mcp/dist/main.js
```

Give it these environment variables:

| Variable              | Value                                                       |
| --------------------- | ----------------------------------------------------------- |
| `FEEDBOUNCER_API_URL` | `https://feedbouncer.example.com`, your FeedBouncer address |
| `FEEDBOUNCER_API_KEY` | Your API key, taken from the client's secret store          |

The transport is stdio: the client writes protocol messages to the server's stdin and reads them from its stdout. The server logs only to stderr. If your client takes the key from an environment reference or a secret prompt, use that instead of typing it into a file. See [authentication](../authentication.mdx).

Clients that read a JSON file usually expect the shape used by [Claude Desktop](claude-desktop.md): `command`, `args` and `env` under the server's name.

## Check it works

The client should list seven tools from the `feedbouncer` server. Then follow [verify your setup](../verify.md).

## If it does not work

- Run the command in a terminal with both variables set. The server prints a one-line reason if it cannot start, then exits. See [troubleshooting](../troubleshooting.md#the-server-exits-at-start).
- If the client cannot find `node`, give it the absolute path from `which node`.
