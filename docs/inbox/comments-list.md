# Workspace comments list

The Comments page (`/orgs/{orgId}/comments`) lists visible comments from every connected account in every brand of the organization, newest first. It is served by `GET /api/v1/orgs/:orgId/comments` and `GET /api/v1/orgs/:orgId/comments/filters`, both requiring `comment.read` (granted to every role).

## What is listed

A comment is listed when all of these hold:

- it is visible (`platform_state = 'visible'`), so hidden and deleted comments drop out on the next request;
- it is not from the brand's own account (`is_own_account`); other people's replies are listed and marked `Reply`;
- its connection is not `revoked` (how "disconnected" is stored);
- its brand is not archived.

The list, the total and every filter option share this one definition.

## Status

No status is stored on a comment. It is derived from existing moderation records; the first match wins.

| Status          | When                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| Flagged         | an open review item exists                                                                                       |
| Awaiting action | a pending action suggestion or a pending moderation action exists                                                |
| Reviewed        | a resolved review item, an approved or dismissed suggestion, a user decision, or a user moderation action exists |
| New             | none of the above                                                                                                |

## Category

The newest non-null `decision.category` for the comment, or `Uncategorized`.

## Ads

- A comment's ad comes from `meta_ad_source` links. A comment linked to several ads is listed once, with the first ad and a count.
- Ad names are read from the Graph `name` field during discovery.
- When an ad's creative changes, the link is soft-unlinked (`unlinked_at`) instead of deleted, so comments keep their ad and the ad filter still matches. Polling skips unlinked sources.
- Meta stops listing deleted ads, so ads that were retired are looked up by id after a complete listing (up to 25 per run) to tell deleted from paused. A deleted ad is shown as `Deleted ad`.

## URL parameters

| Param                | Values                                          |
| -------------------- | ----------------------------------------------- |
| `platform`           | `facebook`, `instagram`                         |
| `ad`                 | an ad id, or `none` for comments not on an ad   |
| `category`           | a category slug, or `_none` for uncategorized   |
| `status`             | `new`, `flagged`, `awaiting_action`, `reviewed` |
| `queue`              | `open` (default), `done`, `all`                 |
| `tags`               | up to 10 comma-separated tag ids (AND)          |
| `before`, `beforeId` | keyset cursor for the next page                 |

Filters combine with AND. Malformed API values return 400; well-formed but stale or foreign values (for example an ad from another organization) are ignored and reported back as `null` in `applied`. The page drops malformed values and falls back to "All".

## Done and open

`queue` selects the view: `open` (no `comment_done` row, the default), `done` (a row exists) or `all`. Done is its own table, independent of `platform_state`: hiding or unhiding a comment never changes it, and marking done never calls a platform. Marking an already-done comment done again changes nothing, so who and when stay as first recorded. Reopening deletes the row. A listed row carries `done: { at, byName } | null`.

## Tags

- Tags belong to the workspace and can be used on comments of every brand. Anyone with `comment.triage` (all roles) can create tags and apply or remove them; deleting a tag needs `tag.manage` (owners and admins).
- A name is trimmed, then must be 1 to 50 code points with no control characters. It is stored as typed. Uniqueness is on the name key (NFC, then lowercase), so `Café`, `café` and `CAFÉ` collide.
- Limits: 200 tags per workspace (`tag_limit_reached`, 409) and 20 per comment (`comment_tag_limit`, reported per comment).
- Errors: `invalid_tag_name` (400, with `reason` naming the broken rule), `tag_name_taken` (409, with the existing `tag`), `tag_limit_reached` (409).
- The `tags` filter matches comments that have **every** selected tag, like the other filters. Stale or foreign tag ids are dropped and `applied.tags` reports what was used.
- Deleting sends `confirmCount`, the number of comments the user saw. If the count differs the API answers 409 `tag_count_changed` with the current `count` and deletes nothing, so the user confirms again.

## Bulk triage

`POST /api/v1/orgs/:orgId/comments/triage` takes 1 to 100 distinct `commentIds` and one `op`: `done`, `reopen`, `add_tags` or `remove_tags` (the tag ops take 1 to 10 distinct `tagIds`). Requires `comment.triage`.

- Each comment is its own transaction. There is no rollback: the response is `results: [{ commentId, status, changed }]` and the caller reads each status.
- Statuses: `ok`, `not_found` (missing, foreign workspace or archived brand), `comment_deleted`, `comment_tag_limit`, `unknown_tag` (the tag was deleted mid-run).
- `changed` is false when the state already matched (an `ok` no-op).
- If a tag id is unknown or foreign before any work starts, the whole request fails with 422 `unknown_tag` and nothing changes.
- Triage is local, so it also works on comments of revoked connections.

## Replying

A moderator replies publicly from the list. Private replies stay on the brand comments page.

- `POST /api/v1/orgs/:orgId/comments/:commentId/replies` with `{ requestKey, text }`; `GET` on the same path lists the comment's public replies, newest first (most recent 50).
- Each row has `reply`: `{ available: true, maxChars }` or `{ available: false, reason }`. The first match decides:
  1. `not_permitted`: the caller lacks `comment.reply`;
  2. `connection_needs_reconnect` or `connection_inactive`;
  3. `unsupported`: no connector, or the platform has no public reply;
  4. `comment_gone`, or the eligibility code (for example a reply to a nested comment whose parent is hidden or too old);
  5. otherwise available, with the platform's public reply limit.
- Idempotency: the web app creates one request key per draft and keeps it across a network error or timeout, so a retry replays it. A new key is made when the text is edited, on a 4xx, when the action ends `failed`, `not_eligible` or `noop`, and after `applied`. The same key with the same text returns the existing action (matched on organization, brand and request key); the same key with different text is 409 `request_key_conflict`. If the platform's response is lost, the retrying job first looks for the account's own reply (`findOwnReply`, only on attempt 2 and later), so the reply is not posted twice.
- Response: 202 when the action is accepted, which includes a replay of a pending, applied or failed action. 200 only when the outcome was recorded without sending anything (`noop` or `not_eligible`).
- Each list row's `replies` holds only pending and applied replies (the latest 3, plus `replyCount`), so a failed reply is never shown as sent. `GET .../:commentId/replies` returns every attempt (up to 50) with its status, including `failed`.
- Errors: 400 `invalid_request` (empty text or over the cap), 403 `forbidden` (no grant), 404 (missing comment or archived brand), 404 `platform_not_configured`, 422 `text_too_long` (with `max`), 422 `unsupported_action`, 409 `connection_needs_reconnect`, `connection_inactive`, `review_mode_active`, `request_key_conflict`.
- Reply text renders only as text, and is never logged or written to audit details.

### Reply permission

`comment.reply` belongs to owners and admins. An owner or admin can grant it to all members with the "Members can reply to comments" checkbox on the Members page (`PUT /api/v1/orgs/:orgId/role-grants` with `{ role: 'member', capability: 'comment.reply', granted }`, requiring `member.change_role`; `GET` needs `member.read`). The grant is per organization, not per user. Revoking it takes effect on the next request (403, and `not_permitted` in the list).

## Audit

Events are written only when state actually changed.

| Action                                      | Subject      | Details                             |
| ------------------------------------------- | ------------ | ----------------------------------- |
| `comment.marked_done`, `comment.reopened`   | comment      | none                                |
| `comment.tagged`, `comment.untagged`        | comment      | `tagId`                             |
| `tag.created`, `tag.deleted`                | tag          | `name`, and `removedFrom` on delete |
| `org.role_grant_changed`                    | organization | `role`, `capability`, `granted`     |
| `comment.moderated` (existing, for replies) | comment      | ids and codes, never reply text     |

## Never sent to platforms

Done, reopen and tags exist only in FeedBouncer. No connector call is made for them. Only a reply is posted to the platform.

## Account problems

- `reconnect_required`: the connection status is `reconnect_required` or `error`, or the last sync error class is `needs_reconnection`.
- `sync_failing`: three or more consecutive failures, the latest after the last success.

Comments from an account with a problem are marked `May be out of date`. Other accounts load normally. "Last synced" is the latest successful sync across listed connections.

## Why no status column

The product already records every state the list needs. Deriving status keeps one source of truth; if the rules engine adds states, the status expression and `COMMENT_STATUSES` change together.
