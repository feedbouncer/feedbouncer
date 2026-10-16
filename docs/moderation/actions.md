# Moderation actions

A rule does not pick a single action. It carries a list of **steps**, and every
step that applies runs when the rule decides a comment. This page lists the
steps, the order they run in, what the outcomes mean, and the limits to know
about. How rules are matched and ordered is in [rules.md](rules.md).

## The steps

| Step          | Label in the app | Reversibility                            | Undo from the log       |
| ------------- | ---------------- | ---------------------------------------- | ----------------------- |
| Hide          | Hide             | Reversible                               | Unhide                  |
| Delete        | Delete           | Irreversible                             | none                    |
| Ban           | Ban author       | Hard to reverse (unban)                  | Unban author            |
| Auto-reply    | Auto-reply       | Partly reversible (reply can be deleted) | none                    |
| Private reply | Private reply    | Irreversible                             | none                    |
| Flag          | Flag for review  | Reversible                               | Dismiss the review item |

- **Hide** hides the comment on the platform. It is still stored and can be
  shown again.
- **Delete** removes the comment from the platform. Ticking it in the editor
  adds a second, unticked box, "I understand deleted comments cannot be
  restored"; the rule cannot be saved until that box is ticked too. Delete is
  never part of a default list of steps.
- **Ban author** bans the comment's author from the Page. It has its own
  unticked box, "I understand a ban is hard to reverse", that must be ticked
  before the rule saves, and it is never a default. Unbanning is
  possible from the log, and an author who was unbanned recently cannot be
  banned again straight away (`reblock_too_soon`). Instagram has no ban.
- **Auto-reply** posts a public reply built from a template. The reply can be
  deleted on the platform afterwards, but FeedBouncer does not undo it for you.
- **Private reply** sends one private message in answer to the comment
  (Messenger on Facebook, a direct message on Instagram). Once sent, it cannot
  be taken back.
- **Flag for review** puts the comment in the [review queue](#review-queue). It
  changes nothing on the platform.

Steps the connected accounts do not support are not offered in the editor.
See [Platform support](#platform-support).

### Undo

Hide, Ban and Flag can be undone from the brand's **Action log**,
which can be filtered by rule, outcome and step; the API can also filter it by
comment. Undoing Hide or Ban asks the platform to unhide or unban, and the log
shows the undo as _in progress_ until the platform answers, then _undone_. An
undone step is a moderator override: automation will not apply it again (see
[Loops and overrides](#loops-and-overrides)).

If the platform refuses or fails the unhide or unban, the log shows "Undo
failed. Try again." with a **Retry undo** button, and the step does not count
as an override. Each retry is a new request; clicking twice sends one. A step
that was already undone, or one with no undo, reports "This step cannot be
undone" or "This step was already undone".

Hides can also be undone from the [Hidden today](undo-log.md) page, which lists
everything hidden since local midnight. A hide made by a rule step is undone
through the same request as the log, so both show one result. Any other hide
(classifier, policy, a person) is unhidden with a request keyed `unhide:` plus
the hide, so repeated clicks send one request. Before an unhide is sent,
FeedBouncer reads the comment from the platform: if it is already visible the
step is skipped as `already_visible`, and if it is gone, as `comment_gone`,
instead of reporting a restore that never happened.

## Execution order

Steps always run in this order, whatever order they were added in:

| #   | Step            | Note                                                 |
| --- | --------------- | ---------------------------------------------------- |
| 1   | Flag for review |                                                      |
| 2   | Private reply   |                                                      |
| 3   | Auto-reply      |                                                      |
| 4   | Hide            |                                                      |
| 5   | Ban             |                                                      |
| 6   | Delete          | Always last; waits until every earlier step is final |

Review comes first, messages go out while the comment still exists, and the
destructive steps come last. A failure never stops the steps after it: each
step records its own outcome and the rest still run.

## Conflicts

These combinations are rejected when the rule is saved:

| Combination                                                       | Why                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| Auto-reply + Hide                                                 | Instagram does not allow replies to hidden comments |
| Auto-reply + Delete                                               | You cannot reply to a comment that is being deleted |
| Private reply + Ban                                               | You cannot message an author who is being banned    |
| Hide + Delete                                                     | Delete already removes the comment                  |
| The same step twice                                               | Each step can be used once                          |
| Any step on an author rule whose list is **allow** or **trusted** | Those lists exist to leave people alone             |

A rule can have at most one of each of the six steps.

## Outcomes and reason codes

Every step ends in one of these outcomes:

| Outcome        | Meaning                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| Pending        | Waiting for the platform, a retry or a reconnect                                  |
| Succeeded      | The platform confirmed it                                                         |
| Failed         | It was attempted and did not work                                                 |
| Skipped        | There was nothing to do, or it was deliberately not repeated                      |
| Not applicable | It cannot apply to this comment                                                   |
| Not supported  | The platform does not offer this step                                             |
| Dry run        | Recorded as a prediction; nothing was sent (see [Dry run](#dry-run-and-simulate)) |

Every outcome other than pending and succeeded carries a reason code. The log
shows the wording from the second column.

### Skipped

| Code                         | Shown as                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| `already_hidden`             | already hidden                                              |
| `already_visible`            | already visible                                             |
| `own_account_comment`        | this comment was written by your own Page                   |
| `private_reply_already_sent` | a private reply was already sent                            |
| `moderator_override`         | a team member reversed this earlier, so it was not repeated |
| `reply_thread_limit`         | this thread already has an automatic reply                  |
| `duplicate`                  | the same step already ran for this comment                  |
| `already_flagged`            | already in the review queue                                 |
| `already_banned`             | this author was already banned                              |

### Not applicable

| Code                           | Shown as                                                             |
| ------------------------------ | -------------------------------------------------------------------- |
| `comment_gone`                 | the comment no longer exists                                         |
| `author_unavailable`           | the author could not be identified                                   |
| `author_is_page`               | the author is your own Page                                          |
| `author_gone`                  | the author no longer exists                                          |
| `private_reply_window_closed`  | the private reply window has closed                                  |
| `private_reply_nested_comment` | Instagram only allows private replies to top-level comments          |
| `reply_to_hidden_comment`      | Instagram does not allow replies to hidden comments; unhide it first |
| `own_comment_always_visible`   | Instagram always shows your own comments, so they cannot be hidden   |

### Not supported

| Code          | Shown as                       |
| ------------- | ------------------------------ |
| `unsupported` | Not available on this platform |

### Failed

| Code                              | Shown as                                              |
| --------------------------------- | ----------------------------------------------------- |
| `missing_permission`              | FeedBouncer lacks the permission for this action      |
| `author_not_bannable`             | Facebook does not allow banning this author           |
| `ban_limit_reached`               | the Page has reached its ban limit                    |
| `reblock_too_soon`                | this author was unbanned too recently to ban again    |
| `text_too_long`, `reply_too_long` | Reply is too long for this platform                   |
| `rate_limit_exhausted`            | the platform kept refusing because of rate limits     |
| `retries_exhausted`               | it kept failing after several tries                   |
| `connection_needs_reconnect`      | this connection needs to be reconnected first         |
| `connection_inactive`             | this connection is not active                         |
| `approver_removed`                | the person who approved this is no longer on the team |
| `request_key_conflict`            | this request was already used for a different action  |
| `failed`                          | the platform did not accept it                        |
| `internal_error`                  | something went wrong on our side                      |

A refusal from Instagram that FeedBouncer does not recognise shows as
`instagram_error_<code>_<subcode>`; see [instagram.md](../connectors/instagram.md).

### Pending

| Code                 | Shown as                                     |
| -------------------- | -------------------------------------------- |
| `rate_limited`       | the platform asked FeedBouncer to slow down  |
| `awaiting_reconnect` | waiting for the connection to be reconnected |

### Dry run

| Code        | Shown as            |
| ----------- | ------------------- |
| `would_run` | this step would run |

Dry run steps otherwise carry the code the real run would have produced.

### Rejected when the rule is saved

| Code                         | Shown as                                                      |
| ---------------------------- | ------------------------------------------------------------- |
| `duplicate_step`             | each step can be used once                                    |
| `reply_to_hidden_comment`    | Auto-reply cannot be combined with Hide                       |
| `reply_to_deleted_comment`   | Auto-reply cannot be combined with Delete                     |
| `message_to_banned_author`   | Private reply cannot be combined with Ban                     |
| `hide_redundant_with_delete` | Delete already removes the comment, so hiding it adds nothing |
| `not_supported_anywhere`     | none of the connected accounts support this                   |
| `template_too_long`          | Reply is too long for this platform                           |

`not_supported_on_platform` ("not available on this platform") is only a
warning: the rule saves, and the step will report "not supported" for comments
from that platform.

When a rule's Hide or Delete step fails or is not supported, the comment is
also flagged for review so that a person looks at it; see
[rules.md](rules.md#actions-and-fallback).

## Dry run and simulate

A rule in **dry run** (shown as "Dry run (log matches only)" in the editor)
writes its steps to the log as _dry run_ entries with the outcome FeedBouncer
predicts from the stored comment. It sends nothing to the platform, creates no
moderation action and no review item, and evaluation continues to the next
rule.

**Simulate** answers the same question for one existing comment and one rule
(`POST /api/v1/orgs/:orgId/brands/:brandId/rules/:ruleId/simulate`), so you can
check a rule, its templates and its permissions before enforcing it.

A prediction is made from what FeedBouncer has stored. The platform can still
refuse for a reason that is only known at the time, such as a Page ban limit.

## Templates

Auto-reply and Private reply use a template. It is plain text, up to 2,000
characters and 20 variables.

| Variable                | Value                              | Longest | If it is missing or unsafe |
| ----------------------- | ---------------------------------- | ------- | -------------------------- |
| `{{author_name}}`       | The author's display name          | 50      | `there`                    |
| `{{author_first_name}}` | The first word of the display name | 30      | `there`                    |
| `{{brand_name}}`        | The brand's name                   | 100     | empty                      |
| `{{platform}}`          | `Facebook` or `Instagram`          | 20      | empty                      |

Write a variable as `{{name}}`, or `{{name|fallback}}` to choose your own
fallback (up to 50 characters): `Hi {{author_first_name|friend}}!`.

- Unknown variables and stray or malformed braces are rejected when the rule is
  saved, so a raw placeholder is never posted.
- Names come from the platform and anyone can choose them. Control and
  invisible characters are removed, and a name that could carry a link, a
  domain, an e-mail address, a @mention, a #tag or a template brace is not
  used: the fallback is used instead. Long values are cut at their maximum
  length. Substituted values are never read as templates again.
- **Length:** the longest possible result (every variable at its maximum, or
  the fallback if that is longer) must fit the reply limit of every connected
  platform that supports the step. Otherwise the rule is rejected when saved,
  and the error names the platform and its limit. The limits are in the table
  below. Lengths are counted in characters (code points).

## During review mode

For the first 7 days after an account is connected, Hide, Delete, Ban author,
Auto-reply and Private reply are suggested instead of run, and wait for a
person to approve them. Flag for review is not held back and behaves as above.
See [review-mode.md](review-mode.md).

## Review queue

**Flag for review** adds the comment to the queue under **Review** for the
brand. A comment has at most one open item at a time, and the item shows the
rule that flagged it. Each open item can be resolved with:

- **Approve:** keeps the comment. If a rule had hidden it, approving shows it
  again.
- **Hide**, **Delete**, **Ban author:** do it now, as a team member's action.
  Delete and Ban ask for confirmation first, and Ban is not offered when no
  connected account can ban.

The queue lists open items only: a resolved item leaves the list (the API can
still list resolved ones with `status=resolved`). Dismissing the item from the
action log (the undo of Flag) closes it without doing anything.

When a rule's Flag for review step runs, the rule's "flag" decision has
usually opened the item already; the step takes that item over, so undoing the
step dismisses it. An item opened by something else (another rule's earlier
evaluation, a classifier or a policy) is left alone and the step is skipped as
`already_flagged`.

## Platform support

| Step          | Facebook                              | Instagram                                                                           |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| Hide          | yes                                   | yes                                                                                 |
| Delete        | yes                                   | yes                                                                                 |
| Ban           | yes                                   | no                                                                                  |
| Auto-reply    | yes (8000 characters)                 | yes (2200 characters, not on hidden comments)                                       |
| Private reply | yes (7 days, once, `pages_messaging`) | yes (7 days, top-level comments only, 1000 characters, `instagram_manage_messages`) |
| Flag          | yes                                   | yes                                                                                 |

Meta ads comments follow the Facebook or Instagram connection that owns the
post: see [meta-ads.md](../connectors/meta-ads.md).

A private reply goes out once per comment, within 7 days of the comment being
posted. See [facebook.md](../connectors/facebook.md) and
[instagram.md](../connectors/instagram.md) for the permissions each platform
asks for.

## Permissions

A step needs the platform permission for its action. When a connected account
did not grant it:

- the editor notes "Needs a permission on …" beside the step before you save;
- saving the rule shows a **warning** that names the account and the missing
  permission, and the rule still saves. The editor stays open with the warning
  and links to the rule and back to the list;
- at run time the step fails with `missing_permission`.

Reconnecting the account and allowing the permission fixes both. A step that no
connected account supports at all is an error and the rule cannot be saved.
Before any account is connected, steps are checked against what each platform
offers by default.

## Rate limits and retries

Actions are sent through the normal moderation request, so they are
deduplicated and rate limited like a manual action. When the platform asks
FeedBouncer to slow down, or fails temporarily, the step stays _pending_ and is
retried with backoff. It ends as `rate_limit_exhausted` if the rate-limit
budget runs out, and as `retries_exhausted` if it keeps failing.

A connection that already needs reconnecting when the step is requested is
refused right away as `connection_needs_reconnect` (Hide and Delete steps then
fall back to a flag decision instead of being lost). Only a connection whose
token expires _while a step is already running_ waits for the reconnect
(`awaiting_reconnect`) and is carried out once it happens.

A comment that is processed twice does not repeat a step: each automated
request has a fixed key built from the comment and the kind of action, and the
second one is recorded as `duplicate`.

## Loops and overrides

Automation is built not to answer itself or fight a moderator:

- Comments written by the connected account itself are never moderated
  (`own_account_comment`), so an auto-reply never triggers a rule.
- At most **one automatic public reply per thread** (the top-level comment and
  its replies). Another rule matching a later reply in the same thread skips
  its Auto-reply with `reply_thread_limit`.
- A team member's own action wins. If someone unhides a comment, or unbans an
  author, after the last automated hide or ban, or undoes a step from the log,
  automation does not apply that step again (`moderator_override`). The check
  runs when a hide is requested: a hide from a rule, the classifier or a policy
  is refused as `moderator_override` when the comment's latest hide or unhide
  is a person's unhide, including one recorded as already visible. The comment
  is flagged for review instead, with the reason "A moderator restored this
  comment, so it was flagged for review instead of hidden." See
  [undo-log.md](undo-log.md#moderator-override).
- Team members commenting from **personal accounts** are not recognised as the
  brand's own account. Add them to an **author rule with the Trusted list**
  (matched by author ID, not by name) so rules and automatic replies leave them
  alone. Steps cannot be added to a rule with an Allow or Trusted list.

## Known limits

- **Sibling replies in one thread.** The one-automatic-reply-per-thread check
  reads the replies already recorded. When two comments of the same thread are
  processed at the same moment, each can pass the check before the other's
  reply is recorded, and both get an automatic reply. It is rare (the comments
  must arrive within the same second or so) and is not prevented yet.

## Known behavior

A rule whose steps are only replies (Auto-reply, Private reply or both) decides
`approve`. The decision stops later rules for that comment, and custom policies
skip it as `rule_decided`. Add Flag for review to the rule if later rules or
policies should still look at the comment.

Decisions are derived from the steps this way: Delete gives `remove`, Hide
gives `hide`, Flag for review gives `flag`, and anything else gives `approve`.
