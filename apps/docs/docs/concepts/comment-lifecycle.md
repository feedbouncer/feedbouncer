---
title: Comment lifecycle
description: What happens to a comment from the moment it arrives until its action is recorded and, where possible, undone.
status: stable
---

Every comment follows the same path.

1. A comment arrives by webhook, poll or backfill. The same comment can arrive more than once, and it is stored once, so repeats are safe (idempotency).
2. Your rules are evaluated, in precedence order. The first enforcing rule that matches decides.
3. If no rule decided, the classifier and your custom policies run, each on its own.
4. The decision is recorded, with its reason and the rule, category or policy behind it.
5. The action steps of the decision run. In review mode, they become suggestions instead.
6. A platform call is made for each step that acts on the platform, and the moderation action is recorded.
7. Undo is available where the platform allows it.

## What is skipped

Some comments never reach the rules, the classifier or the policies:

- Comments deleted on the platform.
- Comments posted by the brand's own account.
- Backfilled comments. Backfill imports recent history so you can see it, but evaluates none of it.

## Arrival

A webhook delivers a comment as it is posted. A poll fetches comments the webhook may have missed. Backfill imports recent history when an account is first connected. A comment that arrives again with the same text changes nothing. An edited comment is evaluated again, and the earlier evaluation stays in its history.

## Evaluation

Rules run in this order: trusted-author rules first, then by priority, then by creation time. The first rule in `enforce` mode that matches decides. A rule in <Term id="dry-run">dry run</Term> records what it would have done and evaluation continues. A rule that takes longer than its 50 ms budget, or that fails, is skipped for that comment.

When no rule decided, the <Term id="classifier">classifier</Term> and the <Term id="policy">policies</Term> are independent. If both want to hide a comment, the second hide changes nothing. A delete wins over a hide. Neither can override a rule.

## Action

A decision carries an ordered list of <Term id="action-step">action steps</Term>. Each step records its own <Term id="outcome">outcome</Term>. If a hide or delete cannot be done on the platform, the comment is flagged for review instead and the decision says why.

## Undo

Hide, ban and flag can be <Term id="undo">undone</Term>. Delete and private replies cannot. See [Decisions and audit](./decisions-and-audit.mdx#undo-log).
