---
title: Claude Code
description: Add the FeedBouncer MCP server to Claude Code with claude mcp add, keeping the key out of shared files.
status: stable
---

## Before you start

Complete the [prerequisites](../prerequisites.md). You need the absolute path to `apps/mcp/dist/main.js` and an API key.

Claude Code stores a server in one of three scopes. `local` (the default) keeps it private to you in one project, `user` keeps it private to you in every project, and `project` writes `.mcp.json`, which is meant to be committed and shared. Use `user` or `local` for FeedBouncer, because the server entry holds your key. Never use `--scope project`.

## Add FeedBouncer

Run this once, with your values in place of the placeholders:

```bash
claude mcp add --scope user feedbouncer --env FEEDBOUNCER_API_URL=https://feedbouncer.example.com --env FEEDBOUNCER_API_KEY=<FEEDBOUNCER_API_KEY> -- node <REPO_DIR>/apps/mcp/dist/main.js
```

Put the name before `--env`, because `--env` takes every value that follows it. Everything after `--` is the command that starts the server.

The command is saved in your own Claude Code settings, not in the repository. Your shell may record the command with the key in its history. Clear that line from your history, or start the command with a space if your shell is set to skip those.

## Check it works

List the servers and ask Claude Code for the details of this one:

```bash
claude mcp list
claude mcp get feedbouncer
```

`feedbouncer` should be listed and connected. In a Claude Code session, `/mcp` shows the same status. Then follow [verify your setup](../verify.md).

## If it does not work

- If `claude mcp list` shows the server as failed, run the `node` command from the add step in a terminal with the same two variables set. The server prints a one-line reason. See [troubleshooting](../troubleshooting.md#the-server-exits-at-start).
- To change the key or URL, remove the server and add it again: `claude mcp remove feedbouncer --scope user`.
- If you added it with a different scope, pass that scope to `claude mcp remove`.
