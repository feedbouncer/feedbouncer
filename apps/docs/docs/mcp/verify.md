---
title: Verify your setup
description: Make a first request through your MCP client and check what a working connection looks like.
status: stable
---

After you add the server, send your assistant this first request:

> List my five most recent FeedBouncer comments.

## What to expect

- The assistant calls the `list_inbox` tool. Most clients show the call and ask you to allow it the first time.
- It answers with up to five comments, newest first. Each shows its platform, status, posting time and author.
- On a fresh install with no comments yet, the tool returns `No comments match.` and the assistant says the inbox is empty. That also means the connection works.

The tool needs only a `read` key, so this request changes nothing.

## Check a write key

Only if your key has the `write` scope, ask for a harmless proposal instead of a reply, for example "Read my rules, then propose a dry-run rule that flags comments with the word giveaway." The assistant calls `read_rules` and then `propose_rule_change`. You get a pending proposal and a review link, and no rule changes until you approve it. See [approving rule changes](approvals.md).

## If it fails

- No `feedbouncer` tools appear: the server did not start. Check your client's page for the command to run by hand, then see [the server exits at start](troubleshooting.md#the-server-exits-at-start).
- The call returns an error line: match it in [troubleshooting](troubleshooting.md).
