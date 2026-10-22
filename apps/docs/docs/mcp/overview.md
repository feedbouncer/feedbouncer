---
title: MCP setup overview
description: What the FeedBouncer MCP server does, how it runs, and where to start.
status: stable
---

The FeedBouncer <Term id="mcp">MCP</Term> server lets an AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io) work with your workspace. It can read and search the comment inbox, reply to comments, hide and unhide them, summarise a period, read your rules and propose rule changes.

It runs on your machine over stdio, started by your MCP client. It has no database or secrets of its own. It is a thin client of the [public API](../api/overview.md) and signs in with one workspace <Term id="api-key">API key</Term>. Everything it can do, the key can do through `/v1`, and nothing more.

<FeatureStatus status="planned">
  A remote MCP server, reached over HTTP with OAuth sign-in, is planned. Today the server speaks
  stdio only, so every client below starts a local process.
</FeatureStatus>

## What you get

The server offers seven <Term id="mcp-tool">tools</Term>: four read tools and three that need a `write` key. See the [tool reference](tools.mdx) for inputs, outputs and limits.

No tool can approve a rule change. A person approves proposals in the web app. See [approving rule changes](approvals.md).

## Set it up

1. Meet the [prerequisites](prerequisites.md): Node 24, a built checkout and an API key.
2. Read how the server [authenticates](authentication.mdx) and how to keep the key out of shared files.
3. Add the server to your client:
   - [Claude Desktop](clients/claude-desktop.md)
   - [Claude Code](clients/claude-code.md)
   - [Cursor](clients/cursor.md)
   - [VS Code](clients/vscode.md)
   - [Any other stdio client](clients/generic.md)
4. [Verify the connection](verify.md) with a first request.

If something fails, see [troubleshooting](troubleshooting.md).
