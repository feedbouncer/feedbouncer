---
title: Troubleshooting
description: Causes and fixes for the failures you are most likely to meet when setting up the FeedBouncer MCP server.
status: stable
---

To see the server's own message, run it in a terminal with the same two variables your client sets:

```bash
FEEDBOUNCER_API_URL=https://feedbouncer.example.com FEEDBOUNCER_API_KEY=<FEEDBOUNCER_API_KEY> node <REPO_DIR>/apps/mcp/dist/main.js
```

## The server exits at start

The server prints one line to stderr and exits with code 1 when its configuration is wrong:

| Message                                                                          | Fix                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `FEEDBOUNCER_API_KEY is missing or malformed`                                    | Set the variable. The key must be `fbk_<16 characters>_<43 characters>`, copied whole with no spaces. |
| `FEEDBOUNCER_API_URL is not a valid URL`                                         | Use a full address that starts with `https://`.                                                       |
| `FEEDBOUNCER_API_URL must use https (http is only allowed for localhost)`        | Use `https`. Plain `http` works only for `localhost`, `127.0.0.1` and `[::1]`.                        |
| `FEEDBOUNCER_API_URL must not contain credentials, a query string or a fragment` | Use the bare address, with no `user:password@`, `?` or `#`.                                           |

When a client launches the server, you usually see this in the client's server log, not on screen.

## The API rejects the key

`FeedBouncer API key rejected` means the API answered `401` to `GET /v1/key`. The key is well formed but unknown or revoked, or it belongs to a different FeedBouncer instance than `FEEDBOUNCER_API_URL`. Check the address, then create a new key under **API keys** and update it in your client. See [authentication](authentication.mdx).

## A write tool says the key is read-only

`This API key is read-only` is a `403 insufficient_scope` from `reply_to_comment`, `set_comment_visibility` or `propose_rule_change`. Create a key with the `write` scope and update your client. Read tools keep working with either scope.

## Connection refused or unreachable

If the API cannot be reached at start, the server still starts and logs a warning. Each tool then fails with `FeedBouncer API error (unreachable).` Causes:

- The address or port is wrong. Open the address in a browser, or call `GET /v1/key` with `curl`, to check it.
- A self-hosted instance is not running, or is not reachable from this machine.
- The API did not answer within 10 seconds.

Fix the address and restart the client.

## The client cannot find node

Clients started from a launcher often do not have your shell's `PATH`. The symptom is an error such as `spawn node ENOENT` or a server that fails at once. Run `which node` (`where node` on Windows) and put that absolute path in the `command` field instead of `node`. The path to `main.js` must be absolute too.

## The Windows config file is not found

On Windows, if the client's config file is reported missing (`ENOENT`), the folder or the file does not exist yet. Open the path the client's settings show, create the missing folder and the file with the entry from the [desktop app page](clients/desktop-app.md). Make sure the file's name does not end in `.txt`.

## Rate limited

Tools return `Rate limited. Retry after N seconds.` when the key has used its per-minute budget (`429 rate_limited`). Wait the number of seconds shown. The limit is per key, so several assistants sharing a key share the budget. See [rate limits](../api/rate-limits.mdx).
