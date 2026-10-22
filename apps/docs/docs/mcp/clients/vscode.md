---
title: VS Code
description: Add the FeedBouncer MCP server to VS Code with a mcp.json that prompts for the key.
status: stable
---

## Before you start

Complete the [prerequisites](../prerequisites.md). You need the absolute path to `apps/mcp/dist/main.js` and an API key. You also need an MCP-capable version of [VS Code](https://code.visualstudio.com).

The workspace file `.vscode/mcp.json` is usually committed. The file below holds no secret, because VS Code asks for the key the first time the server starts and stores it for you. If you prefer, run **MCP: Open User Configuration** from the Command Palette and put the same content there.

## Add FeedBouncer

Run **MCP: Open Workspace Folder MCP Configuration**, or create `.vscode/mcp.json`, with this content:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "feedbouncer-api-key",
      "description": "FeedBouncer API key",
      "password": true
    }
  ],
  "servers": {
    "feedbouncer": {
      "type": "stdio",
      "command": "node",
      "args": ["<REPO_DIR>/apps/mcp/dist/main.js"],
      "env": {
        "FEEDBOUNCER_API_KEY": "${input:feedbouncer-api-key}",
        "FEEDBOUNCER_API_URL": "https://feedbouncer.example.com"
      }
    }
  }
}
```

`password: true` hides what you type. The `<REPO_DIR>` path is specific to your machine, so keep the file out of version control or use the user configuration.

## Check it works

Open the Command Palette and run **MCP: List Servers**. Start `feedbouncer` and paste your key when asked. It should show as running. Then follow [verify your setup](../verify.md).

## If it does not work

- If you entered the wrong key, the server stops at start with a key error. See [troubleshooting](../troubleshooting.md#the-api-rejects-the-key) for how to tell a malformed key from a rejected one.
- If VS Code cannot start `node`, replace `"node"` with the absolute path from `which node`.
- For the server's own errors, open the server's output from **MCP: List Servers**, and see [troubleshooting](../troubleshooting.md#the-server-exits-at-start).
