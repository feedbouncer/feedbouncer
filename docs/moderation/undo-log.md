# Undo log: Hidden today

**Hidden today** lists every comment FeedBouncer hid since local midnight, across
all the Facebook and Instagram accounts you can moderate, newest first. Each row
shows the comment, its author, the platform and account, when it was hidden,
who or what hid it and why. **Unhide** restores it in one click. The page is at
`/hidden-today` and is linked from the organizations pages. It is separate from
the brand's Action log ([actions.md](actions.md#undo)), which covers rule steps
of every kind.

## What is listed

A row is the latest hide of a comment that was applied on the platform today.

| Listed                                                             | Not listed                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| Hides by a rule, the classifier, a custom policy or a person       | Dry-run decisions (nothing was sent)                 |
| Hides from an accepted suggestion                                  | Review-mode suggestions that were never accepted     |
| A hide that was unhidden today (the row shows what happened to it) | Hides that failed, were skipped or are still pending |
|                                                                    | Comments hidden on the platform outside FeedBouncer  |
|                                                                    | Hides from before today's midnight                   |

A comment hidden twice today appears once, with its latest hide. The row's
history shows the hides and unhides of that comment today (the last 10).
The list covers every organization where your role can moderate comments.

## The day boundary

"Today" starts at midnight in the **brand's timezone**, not yours, so each row
uses its own brand's midnight. A brand's timezone is an IANA name such as
`Europe/Berlin` and is set when the brand is created or in its settings (admins
only). Brands that existed before this feature, and brands created without a
zone, use `UTC` until someone sets one. While a brand is on the default the page
says "Today for _brand_ uses UTC midnight" and offers **Use _your timezone_**,
or "Ask an admin to set it" if you cannot manage the brand. The window runs to
the moment you load the page.

## Reason and source

Every row names its source: a rule (by name), the classifier (with the category),
a custom policy, a suggestion someone accepted, a person, or the system. The
reason line combines the rule name with the decision's reason when there is one.
A row is never blank: it falls back to "Hidden manually" for a person's hide and
"Reason not recorded" otherwise.

## Row states

| State               | Label shown         | When                                                           | Unhide offered |
| ------------------- | ------------------- | -------------------------------------------------------------- | -------------- |
| Hidden              | none                | No unhide has been tried                                       | yes            |
| Pending             | Pending             | The unhide is waiting for the platform, a retry or a reconnect | no             |
| Restored            | Restored            | The platform confirmed the unhide                              | no             |
| Already visible     | Already visible     | The platform showed the comment before the unhide was sent     | no             |
| No longer available | No longer available | The comment was deleted on the platform; nothing is unhidden   | no             |
| Failed              | Couldn't unhide     | The platform refused or failed; the reason is shown            | yes (retry)    |

Before an unhide is sent, FeedBouncer reads the comment from the platform. The
platform reports success when asked to unhide a comment that is already visible,
so without that check the row would wrongly say "Restored". A comment that
turns out to be visible is recorded as `already_visible`, and one that is gone as
`comment_gone`. A pending unhide updates in place on the page; no reload is
needed.

When an unhide cannot be sent, the row stays hidden and can be tried again:

- the account needs reconnecting, or is disconnected: "Reconnect your account
  to unhide this comment." with a link to reconnect;
- the account did not grant the unhide permission: the message names it;
- the platform failed or asked to slow down: a specific reason, or "Couldn't
  unhide, try again."

## Purged actions

The page lists hides from today only, so the retention purge
([data-retention.md](../operations/data-retention.md)) rarely touches it. But a
hide whose comment or action record has been deleted, by the `comments` or
`decisions` retention category or by a subject erasure
([subject-requests.md](../operations/subject-requests.md)), is no longer listed
and can no longer be undone from here. Deleting the record does not unhide the
comment on the platform.

## Moderator override

An unhide on this page is a person's action, recorded with the hide it reverses.
Automation then leaves the comment alone: a hide by a rule, the classifier or a
policy is refused as `moderator_override`, and the comment is flagged for review
with the reason "A moderator restored this comment, so it was flagged for review
instead of hidden." instead.

The override applies when the comment's most recent hide or unhide that counts
is a person's unhide. An unhide counts when it is pending or applied, and also
when it was recorded as already visible, because the person still meant the
comment to stay up. A failed unhide does not count. A person hiding the comment
again clears the override. The check lives in the one place that takes moderation
requests, so it covers rules, the classifier, policies and the ingest path alike.

## Idempotency

The unhide request key is built on the server, never taken from the browser:

| Key                                 | Used for                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `unhide:<hideActionId>`             | The first attempt                                                |
| `unhide:<hideActionId>:<attemptId>` | A retry after a failed attempt (`<attemptId>` is the failed one) |
| `undo:<stepId>`                     | A hide made by a rule step: the Action log's own undo is reused  |

Clicks from two tabs, double clicks and concurrent requests collapse into one
platform call. Repeating the request after it settled changes nothing and
returns the row as it is. `unhide:` is a reserved prefix: a client cannot supply
a key that starts with it.

## API

| Request                                                                         | Purpose                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/me/hidden-today?limit=&before=&beforeId=`                          | The page: `items`, `next` cursor and each brand's day (`brands`) |
| `GET /api/v1/orgs/:orgId/brands/:brandId/hidden-comments/:hideActionId`         | One row, polled while it is pending                              |
| `POST /api/v1/orgs/:orgId/brands/:brandId/hidden-comments/:hideActionId/unhide` | Unhide; `202` while pending, `200` once settled                  |

Both per-brand requests need the `comment.moderate` capability. The list is
paged (50 by default, 100 at most) by a keyset cursor on hide time and id. A
refused unhide answers `409` with `connection_needs_reconnect`,
`connection_inactive` or `missing_permission`. Rows leave out internal run step
ids.

## Performance

The list is served by a partial index on applied hides, ordered by completion
time, kept per brand (`organization_id, brand_id, completed_at DESC, id DESC`).
Since the window is per brand, the query reads each brand's own range.

## Limits

- A row is the latest hide of its comment only; an earlier hide of the same
  comment today is shown in the row's history, not as a row.
- Only hides that FeedBouncer applied are listed. A comment hidden by hand on
  Facebook or Instagram is not.
- A comment deleted on the platform cannot be restored and stays listed as "No
  longer available".
