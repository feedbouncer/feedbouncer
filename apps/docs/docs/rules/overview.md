---
title: Rules overview
description: How rules work in FeedBouncer, the fields of a rule, and where to go next.
status: stable
---

A <Term id="rule">rule</Term> tells FeedBouncer what to do with a comment that matches its conditions. Rules belong to a brand, are managed under **Rules** in the web app, and run before the AI classifier and custom policies. A comment is evaluated once per version of its text, in a background job, so evaluation never slows down ingestion.

## The fields of a rule

| Field        | Meaning                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`       | 1 to 200 characters. Decisions in the log show this name.                                                                    |
| `conditions` | What the rule matches. One [condition](./conditions.mdx) per rule: keyword, regex, link domain, emoji, author or competitor. |
| `actions`    | The [steps](./actions.mdx) that run when the rule decides a comment, up to one of each step type.                            |
| `mode`       | `enforce` acts on a match. `suggest` is shown as **dry run** in the app and only records what the rule would have done.      |
| `enabled`    | A disabled rule is ignored.                                                                                                  |
| `appliesTo`  | **Applies to** in the app: `all` (the default), `organic` or `ad`. See [Organic and ad comments](#organic-and-ad-comments).  |
| `priority`   | The position in the brand's list. A lower number runs first. Reordering the list sets it.                                    |

A rule created through the public API or the MCP server starts in `suggest` mode unless it says otherwise.

## How a comment is evaluated

1. The brand's enabled rules are put in [evaluation order](./precedence.md).
2. Each rule is checked against the comment. The first `enforce` rule that matches decides, and its steps run.
3. If no rule decides, the classifier and the custom policies look at the comment. See [When no rule matches](./precedence.md#when-no-rule-matches).

Comments written by the brand's own account are never evaluated, and neither are backfilled historical comments. Edited comments are evaluated again, and the earlier evaluation stays in the history.

## Organic and ad comments

Every comment is either **organic** (on your own posts and videos) or **ad** (on an ad). A rule set to `organic` only sees organic comments, one set to `ad` only sees ad comments, and one set to `all` sees both. A rule that does not apply to a comment is skipped as if it were not in the list, so the next rule can decide. Existing rules apply to all comments.

The [moderation check](../api/moderation-check.md) has no post or ad, so it treats its text as organic: rules set to `ad` never match there.

## Data and privacy

A decision stores the rule, the terms or hosts that matched and a readable reason. It never stores the comment text.

## In this section

- [Conditions](./conditions.mdx): the six condition types and their fields.
- [Actions](./actions.mdx): the steps, their order, conflicts and undo.
- [Precedence](./precedence.md): which rule wins, and what happens when none does.
- [Testing and changing rules](./testing-and-changing-rules.md): dry run, simulate, editing and deleting.
- [Worked examples](./examples.mdx): rules checked against the real engine.
- [Limits](./limits.mdx): the size limits of rules.
