---
title: Precedence and evaluation order
description: Which rule decides a comment, how dry-run rules behave, and what happens when no rule matches.
status: stable
---

When several rules could match a comment, the order below decides which one acts.

## Evaluation order

1. **Trusted-author rules** are checked first, whatever their priority. They are pinned to the front.
2. The remaining enabled rules follow by `priority`, lowest number first.
3. Rules with the same priority run in the order they were created.

The first rule in `enforce` mode that matches **decides** the comment and stops the search for acting rules. An allow from a trusted author therefore skips every rule below it. [Trusted author wins](./examples.mdx#a-trusted-author-beats-a-keyword-rule) shows this.

Every other enforce rule that also matches does nothing. During [review mode](#during-review-mode) only, the decision also lists them as also matched; otherwise the decision records just the rule that decided. [The lower priority number decides](./examples.mdx#the-lower-priority-number-decides) shows this.

A rule that can never fire, because an earlier rule always matches first or because its list is empty, is flagged in the list.

## Dry-run rules

A rule in `suggest` mode never decides. When it matches, FeedBouncer records the steps it would have run as a suggestion, and evaluation continues with the next rule. Dry-run rules that come after the deciding rule are not checked.

## Rules beat the AI

An enforcing rule that decides a comment ends the evaluation, including a rule that only approves. The classifier and the custom policies are not asked, and neither can override a rule's decision.

## The time budget

Each rule has a budget of 50 ms for one comment. A rule that exceeds it or fails is skipped for that comment, and evaluation goes on with the next rule. A skipped rule is recorded in the decision's trace. A rule whose conditions no longer validate is left out of the rule set altogether and never runs; FeedBouncer logs a warning, but it does not appear in the trace.

## When no rule matches

If no enforcing rule decided the comment, two optional stages look at it. They are independent: each records its own decision and acts on its own.

- The [classifier](../concepts/ai-classifier-and-policies.md) scores the comment against the brand's category thresholds.
- The brand's custom policies are checked by a language model.

If both want to hide, the second hide changes nothing. A delete wins over a hide, because the delete is the one carried out. Without a configured classifier or policies, nothing else happens and the comment stays visible.

[No rule matches](./examples.mdx#no-rule-matches) shows a comment that reaches this stage.

## During review mode

For the first 7 days after an account is connected, a matching rule still records its decision, but its Hide, Delete, Ban author, Auto-reply and Private reply steps become a suggestion for a person to approve. Flag for review runs as usual. See [Review mode](../concepts/review-mode.md).
