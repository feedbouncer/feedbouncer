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
| `before`, `beforeId` | keyset cursor for the next page                 |

Filters combine with AND. Malformed API values return 400; well-formed but stale or foreign values (for example an ad from another organization) are ignored and reported back as `null` in `applied`. The page drops malformed values and falls back to "All".

## Account problems

- `reconnect_required`: the connection status is `reconnect_required` or `error`, or the last sync error class is `needs_reconnection`.
- `sync_failing`: three or more consecutive failures, the latest after the last success.

Comments from an account with a problem are marked `May be out of date`. Other accounts load normally. "Last synced" is the latest successful sync across listed connections.

## Why no status column

The product already records every state the list needs. Deriving status keeps one source of truth; if the rules engine adds states, the status expression and `COMMENT_STATUSES` change together.
