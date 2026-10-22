---
title: Decisions and audit
description: What FeedBouncer stores about each decision, each action step and each undo, and how long it keeps it.
status: stable
---

FeedBouncer records why every automated action happened.

## Decisions

A <Term id="decision">decision</Term> is one row per outcome for a comment. It stores:

- the outcome: `approve`, `flag`, `hide` or `remove`
- the mode: `enforce` or `suggest`
- the actor: a person, a rule, the classifier or a custom policy
- the reason, in readable text
- the rule, when a rule decided
- the classifier provider and model, the category and the confidence, when the classifier decided

Decisions are append-only. A later decision for the same comment does not change an earlier one. Every automated action carries a reason. The reason does not include the comment text.

## Action steps and outcomes

Each <Term id="action-step">action step</Term> of a decision records its own <Term id="outcome">outcome</Term>: succeeded, failed, skipped, not applicable, not supported, simulated or still pending. A failed hide or delete flags the comment for review.

<ReferenceTable
kind="steps"
data={[
{ type: 'flag_for_review', reversible: true, undo: 'dismiss_review' },
{ type: 'private_reply', reversible: false, undo: 'none' },
{ type: 'auto_reply', reversible: false, undo: 'none' },
{ type: 'hide', reversible: true, undo: 'unhide' },
{ type: 'ban', reversible: false, undo: 'unban_author' },
{ type: 'delete', reversible: false, undo: 'none' },
]}
/>

A ban can be undone, but it is hard to reverse. An auto-reply is only partly reversible and has no undo. Deleting a comment and sending a private reply cannot be undone.

## Undo log

The <Term id="hidden-today">Hidden today</Term> page lists every comment hidden since midnight in the brand's time zone, with its source and reason. It offers Unhide in one click. It lists hides applied on the platform, including those from rules, the classifier, policies and people. Dry-run decisions and suggestions nobody accepted are not listed.

A comment that was undone counts as a moderator override, so automation does not apply the same step again.

## Retention and deletion

You choose how long each kind of data is kept. See <RepoLink path="docs/operations/data-retention.md">data retention</RepoLink> for the categories and <RepoLink path="docs/operations/data-deletion.md">data deletion</RepoLink> for deleting an organization. Deleting a record does not unhide a comment on the platform.
