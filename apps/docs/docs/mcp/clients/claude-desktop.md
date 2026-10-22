---
title: Claude Desktop
description: Add the FeedBouncer MCP server to Claude Desktop with a claude_desktop_config.json entry.
status: stable
---

## Before you start

Complete the [prerequisites](../prerequisites.md). You need the absolute path to `apps/mcp/dist/main.js` and an API key.

Claude Desktop reads its servers from `claude_desktop_config.json`:

| System  | Location                                                          |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     |

## Add FeedBouncer

Open the file, or create it, and add a `feedbouncer` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "feedbouncer": {
      "command": "node",
      "args": ["<REPO_DIR>/apps/mcp/dist/main.js"],
      "env": {
        "FEEDBOUNCER_API_URL": "https://feedbouncer.example.com",
        "FEEDBOUNCER_API_KEY": "<FEEDBOUNCER_API_KEY>"
      }
    }
  }
}
```

Replace `<REPO_DIR>` with the absolute path of your checkout, and `<FEEDBOUNCER_API_KEY>` with your key. On Windows, write the path with forward slashes or doubled backslashes. If the file already has other servers, add `feedbouncer` next to them.

<FeatureStatus status="partial">
  This file holds the key in plain text. Keep it readable by you only, never commit it and never
  sync it between machines. Claude Desktop has no secret prompt for MCP servers, so use a `read`
  key unless you need to write, and rotate it if the file is ever shared.
</FeatureStatus>

Quit Claude Desktop completely and start it again. It reads the file only at start.

## Check it works

Open the tools or connectors menu in a new chat. `feedbouncer` should be listed with seven tools. Then follow [verify your setup](../verify.md).

## If it does not work

- Check the file is valid JSON. A trailing comma stops Claude Desktop from loading any server.
- If Claude Desktop cannot start `node`, replace `"node"` with the absolute path from `which node`.
- On Windows, if the file is not found, see [troubleshooting](../troubleshooting.md#the-windows-config-file-is-not-found).
- For the server's own errors, see [troubleshooting](../troubleshooting.md#the-server-exits-at-start).
