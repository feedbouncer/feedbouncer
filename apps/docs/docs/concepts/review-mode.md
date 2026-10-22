---
title: Review mode
description: For the first 7 days after an account is connected, FeedBouncer suggests actions and waits for a person to approve them.
status: stable
---

For the first 7 days after an account is connected, FeedBouncer only **suggests**. Rules, the classifier and custom policies still decide what should happen to each comment. The actions that change anything on the platform wait for a person to approve them under **Suggestions**.

## What it is

<Term id="review-mode">Review mode</Term> is on by default for every newly connected account. The connect screen shows **Start in review mode (recommended)**, ticked. While the window is open, the brand shows a banner with the end time and the number of suggestions waiting.

## What is suggested and what still runs

These steps become <Term id="suggestion">suggestions</Term> instead of running, whichever rule, classifier verdict or policy asked for them:

- Hide
- Delete
- Ban author
- Auto-reply
- Private reply

**Flag for review** is not held back. Evaluation, dry runs and decision records behave as before. Actions taken by a team member, including Unhide and Unban author, are never held back.

## The 7-day window

- The window starts when the account is first connected and lasts exactly 168 hours. It is stored in UTC and shown in your local time.
- Reconnecting the same account does not restart it, and an opt-out sent with a reconnect is ignored.
- Backfilled history is not evaluated, so it produces no suggestions. Comments that arrive while the window is open do.
- A comment evaluated inside the window stays a suggestion even if its job finishes after the window ends.

## Suggestions

There is at most one pending suggestion per comment, however many sources matched it.

- Every source is listed with its reason: the rule name, the classifier or the custom policy.
- The plan merges the steps of every source, one per step type, in execution order.
- Steps that cannot be combined are dropped, and the reason is shown. Hide is dropped when Delete is present. Auto-reply is dropped when the comment is hidden or deleted. Private reply is dropped when the author is banned.
- Approving runs each step once, as the person who approved. The platform sees that person's permissions.

**Approve** runs the plan, and asks for confirmation first if it includes Delete or Ban author. **Dismiss** runs nothing. You can approve or dismiss several at once, or act on every pending suggestion from one author.

The first decision wins. If a second moderator acts on a suggestion that is already decided, they see who handled it and nothing runs again.

A pending suggestion closes without running anything when the comment was deleted or edited after the suggestion was made, or when the rule behind it was changed or turned off.

## Ending review mode

An admin can end review mode early from the banner and choose what happens to the waiting suggestions: leave them, dismiss them all, or approve them all. Approving all runs every suggested action, including deletes and bans, and needs an extra confirmation.

Unticking **Start in review mode** at connect shows a warning, and the account connects only after you confirm. The choice is recorded in the audit log.

## What happens at the end

When the window ends, rules, the classifier and policies run at their configured level for new comments. Nothing still pending runs automatically. Waiting suggestions can be approved or dismissed for another 72 hours. After that they expire, and nothing is run.

The audit log for review mode is described in the <RepoLink path="docs/moderation/review-mode.md">review mode operator reference</RepoLink>.
