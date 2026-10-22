---
title: Cursor
description: Add the FeedBouncer MCP server to Cursor with a global mcp.json that reads the key from your environment.
status: stable
---

## Before you start

Complete the [prerequisites](../prerequisites.md). You need the absolute path to `apps/mcp/dist/main.js` and an API key.

Cursor reads servers from `mcp.json`. Use the global file, `~/.cursor/mcp.json`, and not the project file `.cursor/mcp.json`, which usually lives in a repository where it can be committed.

Export the key in the environment Cursor starts from, for example in your shell profile. Then start Cursor from a shell that has it, or restart your session after you add it:

```bash
export FEEDBOUNCER_API_KEY=<FEEDBOUNCER_API_KEY>
```

## Add FeedBouncer

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "feedbouncer": {
      "type": "stdio",
      "command": "node",
      "args": ["<REPO_DIR>/apps/mcp/dist/main.js"],
      "env": {
        "FEEDBOUNCER_API_URL": "https://feedbouncer.example.com",
        "FEEDBOUNCER_API_KEY": "${env:FEEDBOUNCER_API_KEY}"
      }
    }
  }
}
```

Cursor replaces `${env:FEEDBOUNCER_API_KEY}` with the value from its environment, so the file holds no secret.

## Check it works

Open Cursor Settings and find the MCP section. `feedbouncer` should show a green status and seven tools. Then follow [verify your setup](../verify.md).

## If it does not work

- If the server shows an error about the key, Cursor did not get the variable. Cursor may not see a variable that was set only in a terminal after it started. Quit it and start it again from a shell that has the variable.
- If Cursor cannot start `node`, replace `"node"` with the absolute path from `which node`.
- For the server's own errors, see [troubleshooting](../troubleshooting.md#the-server-exits-at-start).
