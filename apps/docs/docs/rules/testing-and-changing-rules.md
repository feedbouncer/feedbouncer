---
title: Testing and changing rules
description: Try a rule in dry run, simulate it on a comment, switch it to enforce, edit it and delete it.
status: stable
---

A rule can act on real comments as soon as it is in `enforce` mode, so try it first.

## Try a rule in dry run

Create the rule in **dry run** (`mode: suggest`). It writes the steps it would have run to the log as _dry run_ entries, with the outcome FeedBouncer predicts from the stored comment. It sends nothing to the platform, opens no review item and creates no moderation action. [Try a competitor rule in dry run](./examples.mdx#try-a-competitor-rule-in-dry-run) shows one.

Leave the rule in dry run for a few days and read the log. When the matches are the ones you want, switch the rule to enforce.

## Simulate a rule on one comment

**Simulate** answers the same question for one existing comment and one rule. You can check the rule, its reply templates and its permissions before enforcing it.

A prediction uses what FeedBouncer has stored. The platform can still refuse for a reason that is only known at the time, such as a Page ban limit.

## Check text without storing it

The public API's `checkModeration` operation evaluates arbitrary text against a brand's rules, the classifier and the policies, and stores nothing. See the [API reference](../api/overview.md).

## Switch to enforce

Change the mode from dry run to enforce in the editor. From then on the rule decides the comments it matches. Comments that were already evaluated are not evaluated again.

## Edit a rule

Editing a rule changes how new and edited comments are evaluated. Decisions already recorded keep the rule name they were made under. Reordering the list changes the [evaluation order](./precedence.md).

A rule change proposed through the public API or the MCP server waits for a person to approve it in the dashboard, and nothing changes until then. A proposal is rejected when its conditions match everything ordinary comments say, such as a pattern that matches an empty text, or when it duplicates or conflicts with an existing rule. A proposal for a disabled rule skips those checks, so a bad rule can always be switched off.

## Delete a rule

A rule cited by a past decision cannot be removed without losing the audit trail, so deleting a rule archives it. It disappears from the list, and earlier decisions still show its name.
