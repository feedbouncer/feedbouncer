# Review mode

Operator reference. For the user-facing explanation, see the [documentation site](https://feedbouncer.github.io/feedbouncer/docs/concepts/review-mode/).

For the first 7 days after an account is connected, FeedBouncer only
**suggests**. Rules, the classifier and custom policies still decide what
should happen to each comment, but the actions that change anything on the
platform wait for a person to approve them under **Suggestions**. This page
describes what is held back, how the window works and how suggestions are
decided. How rules, the classifier and policies pick an action is in
[rules.md](rules.md), [classifier.md](classifier.md) and
[policies.md](policies.md); the steps themselves are in
[actions.md](actions.md).

## What it is

Review mode is on by default for every newly connected account. There is
nothing to set up. The connect screen shows **Start in review mode
(recommended)**, ticked, and the app shows a banner on the brand while the
window is open, with the end time and the number of suggestions waiting.

## What is suggested and what still runs

These steps are suggested instead of run, whichever rule, classifier verdict or
policy asked for them:

- Hide
- Delete
- Ban author
- Auto-reply
- Private reply

**Flag for review** is not held back: flagged comments reach the
[review queue](actions.md#review-queue) as before. Evaluation, dry runs and
decision records also behave as before. Actions taken by a team member
(including Unhide and Unban author) are never held back.

## The 7-day window

- The window starts when the account is first connected and lasts exactly 168
  hours. It is stored in UTC and shown in your local time, so a daylight saving
  change does not move the end by an hour.
- Reconnecting the same account does not restart it, and an opt-out sent with a
  reconnect is ignored.
- Accounts connected before this release are not affected: they keep running
  rules at their configured level.
- Backfilled history is not evaluated, so it does not produce suggestions
  (see [rules.md](rules.md#idempotency-and-scope)). Comments that arrive while
  the window is open do.
- A comment evaluated inside the window stays a suggestion even if its job
  finishes after the window has ended.

## Suggestions

There is at most one pending suggestion per comment, however many rules,
classifier verdicts or policies matched it.

- Every source is listed with its reason: the rule name, the AI classifier, or
  the custom policy. Other rules that matched the same comment appear as "Also
  matched".
- The proposed plan merges the steps of every source, one per step type. When
  two sources configure the same step, the earlier source decides its
  settings, such as the reply template. The plan is shown in execution order.
- Steps that cannot be combined are dropped and the reason is shown: Hide when
  Delete is present, Auto-reply when the comment is hidden or deleted, and
  Private reply when the author is banned (see
  [conflicts](actions.md#conflicts)).
- A classifier or policy that would hide proposes Hide; one that would remove
  proposes Delete.
- Approving runs each step of the plan once, as the person who approved. The
  actions appear in the action log and the platform sees that person's
  permissions, not a background process.

## Approve, dismiss, bulk and repeat offenders

- **Approve** runs the plan. If it includes Delete or Ban author, the app asks
  for confirmation first.
- **Dismiss** runs nothing and closes the suggestion.
- **Bulk:** select suggestions on the page, or use "Select all on this page",
  then approve or dismiss them together.
- **Repeat offenders:** a row shows how many suggestions are pending from the
  same author and links to them. "Approve all from this author" and "Dismiss
  all from this author" act on every one. Approving several suggestions for one
  author bans them once; the other bans are skipped as `already_banned`.
- The queue can be filtered by account, rule, proposed action, status and
  author.

## Multiple moderators

The first decision wins. If a second moderator approves or dismisses a
suggestion that someone else has already decided, they see "Already handled
by" with the first person's name and time, and nothing runs again. Repeating
the same request, for example a double click, returns the first result.

## When a suggestion no longer applies

A pending suggestion is closed without running anything when:

- the comment was deleted: "No longer applicable: the comment was deleted.";
- the comment was edited after the suggestion was made: "No longer
  applicable: the comment was edited after this suggestion was made.";
- the rule behind it was changed or turned off: "Withdrawn: the rule behind
  this suggestion was changed or turned off." Editing a rule updates or withdraws
  its pending suggestions.

The rest of the plan is re-checked when you approve, so a suggestion never
runs steps that a rule no longer asks for.

## If the account needs reconnecting

Approving follows the normal reconnect behavior. If the account needs to be
reconnected, the approval is refused and the suggestion stays pending. If it
becomes unavailable partway through a bulk approval, the bulk stops and the
rest stay pending. If the person who approved has since been removed from the
team, the steps fail with `approver_removed` rather than run under another identity.

## Ending review mode early

An admin can end review mode for an account from the banner. The dialog asks
what to do with the suggestions waiting:

- **Leave them waiting (they expire 72 hours after review mode ends).**
- **Dismiss all.**
- **Approve all (runs every suggested action, including deletes and bans).**
  This needs an extra confirmation.

Rules then run at their configured level straight away.

## Turning it off at connect

Unticking **Start in review mode (recommended)** shows this notice: "Without
review mode, your rules, the classifier and your policies start hiding,
deleting, banning and replying as soon as this account is connected. A mistake
in a rule can affect real people before you notice. We recommend keeping
review mode on for the first 7 days." The account connects only after you tick
**I understand. Start automation now.** The choice is recorded in the audit
log.

## What happens at the end

When the window ends, rules, the classifier and policies run at their
configured level for new comments. Nothing still pending runs automatically.
The banner stays until the waiting suggestions are dealt with and shows when
they expire. They can be approved or dismissed for another 72 hours (the grace
period); after that they expire: "Expired: not reviewed within 72 hours after
review mode ended. Nothing was run." The grace period counts from the end of
the window, or from the moment review mode was ended early.

## Audit log

| Entry                       | Recorded when                                       |
| --------------------------- | --------------------------------------------------- |
| `review_mode.opted_out`     | An account is connected with review mode turned off |
| `review_mode.ended_early`   | An admin ends review mode before the window closes  |
| `suggestion.approved`       | A person approves a suggestion                      |
| `suggestion.dismissed`      | A person dismisses a suggestion                     |
| `suggestion.bulk_requested` | A bulk approve or dismiss is requested              |

Each entry records who acted and when. Comment text and author names are never
written to the audit log. Expiry and withdrawal are system decisions and show
on the suggestion itself.
