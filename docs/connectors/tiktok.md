# TikTok connector (organic)

Setup, permissions, behaviour and known limitations of the TikTok connector
(`@feedbouncer/connector-tiktok`), which moderates comments on a TikTok
Business account's own videos. Comments on TikTok ads are a separate
connector: see [tiktok-ads.md](tiktok-ads.md). For how a connector fits the
framework, see [writing-a-connector.md](writing-a-connector.md).

> **Not yet checked against the live TikTok API.** No TikTok developer app
> with sandbox access was available while this connector was built. The
> endpoints, scopes, token lifetimes and error codes it uses are the documented
> or expected ones, and every one of them is still an unverified assumption.
> The list, with what changes if an assumption is wrong, is in
> [the `tiktok-business-api` README](../../packages/tiktok-business-api/README.md#verified-behaviour-api-v13-checked-2026-10-24)
> (rows V1 to V10 and V17 to V19 concern this connector). All tests run
> against a fake of the TikTok API, never the real one.

## What it covers

One connection is one TikTok Business account, in one brand.

- **In:** comments and replies on the account's videos, read by polling. Each
  comment is stored with an **Organic** label and a link to its video.
- **Out:** hide, unhide and delete a comment, and a public reply.

Out of scope: direct messages, LIVE comments, posting or editing videos,
analytics, personal (non-business) TikTok accounts, and comments on ads (see
[tiktok-ads.md](tiktok-ads.md)).

## Create the TikTok developer app

1. Create a developer app on the TikTok for Business developer portal and
   add the TikTok Accounts (organic) product to it. One app can serve both
   TikTok connectors; the ad connector uses the same app id and secret unless
   you set its own.
2. Register this redirect URI, with your `PUBLIC_WEB_URL` (an origin with no
   path, for example `https://app.example.com`):

   ```text
   ${PUBLIC_WEB_URL}/api/v1/oauth/tiktok/callback
   ```

   The API builds the same URI from `PUBLIC_WEB_URL`, and TikTok must receive
   it exactly. The callback needs the user's FeedBouncer session, so it must be
   reached on the origin the user signed in on.

3. Request the four scopes below and submit the app for review.

Until TikTok approves the app and its scopes, only accounts TikTok allows for
an unreviewed app can connect. Review and scope approval can take weeks, so
start it early.

The exact portal steps, and whether TikTok's review asks for anything beyond
the scopes, have not been checked.

## Permissions (scopes)

FeedBouncer asks for exactly these four scopes and needs all of them. If the
person connecting declines one, the connection is not created and the message
names what was missing.

| Scope                 | Needed for                                       |
| --------------------- | ------------------------------------------------ |
| `user.info.basic`     | Reading the account's username and display name. |
| `video.list`          | Listing the account's videos.                    |
| `comment.list`        | Reading comments and replies on those videos.    |
| `comment.list.manage` | Hide, unhide, delete and public replies.         |

These scope names are the expected ones and are unverified (V4).

## Connect steps

1. An owner or admin of the organization starts the flow from the brand's
   Connections page with **Connect TikTok account**. FeedBouncer sends them to
   TikTok's authorization page with a single-use `state` bound to their
   session and brand.
2. They approve the requested scopes on TikTok. Cancelling there returns to
   the Connections page with nothing connected.
3. FeedBouncer exchanges TikTok's authorization code for tokens, reads the
   account, and shows it for confirmation. Confirming creates the connection.
   The access and refresh tokens are stored encrypted.
4. Polling starts at the next scheduler tick.

PKCE is not sent to TikTok: whether TikTok's authorization endpoint accepts it
is unverified (V1). The flow relies on the session-bound single-use `state`
and the exact redirect URI instead.

A TikTok account can be live in only one workspace at a time.

New connections start in review mode for 7 days: rules still decide, but
their Hide, Delete and reply steps wait as suggestions for a person to approve.
See [review-mode.md](../moderation/review-mode.md).

## Supported actions

From the connector's capabilities (`TIKTOK_ACTIONS` and its `responses`):

| Action          | Supported | Notes                                                                                           |
| --------------- | --------- | ----------------------------------------------------------------------------------------------- |
| Hide / unhide   | yes       | Unverified against live TikTok (V8).                                                            |
| Delete          | yes       | Unverified against live TikTok: deleting other people's comments is assumed to be allowed (V8). |
| Public reply    | yes       | Unverified against live TikTok (V8).                                                            |
| Private reply   | no        | TikTok has no API for it.                                                                       |
| Ban author      | no        | TikTok has no API for it.                                                                       |
| Flag for review | yes       | Local to FeedBouncer; nothing is sent to TikTok.                                                |

If TikTok turns out to allow deleting only the account's own comments, delete
is removed from the connector, and rules that delete then flag for review as
described below.

## Unsupported actions go to manual review

When a rule's step cannot run on TikTok, FeedBouncer never substitutes another
action (it does not hide instead of deleting). The comment is **flagged for
review** and the decision carries the reason:

- `action_not_supported:tiktok:<step>` when TikTok does not offer the step,
  for example `action_not_supported:tiktok:ban`. The review queue shows
  "TikTok doesn't support ban author; review manually."
- `missing_permission:<scope>` when the account did not grant the scope the
  step needs.

This applies on every platform, not only TikTok.

## Latency

Comments arrive by polling only. There are no TikTok webhooks in this version.

- A new comment on a video that is younger than `TIKTOK_ACTIVE_VIDEO_DAYS`
  (30), or had a comment in the last 7 days, appears within one
  `TIKTOK_POLL_INTERVAL_SEC` (5 minutes by default), plus the time a busy queue
  takes to run the job.
- Older, quiet videos are polled every `TIKTOK_QUIET_VIDEO_POLL_INTERVAL_SEC`
  (6 hours by default), so a first comment on one can take that long.
- A newly posted video is picked up within one
  `TIKTOK_VIDEO_DISCOVERY_INTERVAL_SEC` (15 minutes by default).

## Backfill

The first pass after connecting imports the last 30 days of comments, at most
2,000 per connection. Imported comments are labelled as backfilled and rules do
not act on them.

Comments older than that cap but still inside the 30 days can be read later by
a deep scan (below). They then arrive as new comments, and rules evaluate them.

## Replies

Each poll reads the replies of every comment it read that has any. Once every
`TIKTOK_DEEP_SCAN_INTERVAL_SEC` (24 hours by default) a video is re-read in full,
back to the 30-day window, with all replies. A late reply to an older comment
therefore appears within 24 hours in the worst case.

FeedBouncer never hides replies because their parent was hidden. Whether
TikTok hides the replies of a hidden comment itself is unknown (V17).

## Spark Ads

A Spark Ad promotes an organic video, so its comments can be listed both here
and by the ad connector. They are kept as two separate threads: one under the
TikTok account connection and one under the ad account connection. They are
never merged, a reply is only ever linked to a parent in its own thread, and
each copy is moderated through its own API.

## Rate limits and throttling

Each connection has its own request budget (60 requests a minute by default,
with 10 kept back for moderation actions), separate from the ad connector's
and from every other platform. Polling runs at background priority, so it never
delays a moderation action. A TikTok throttle (error code 40100 or HTTP 429)
defers the poll, which resumes from its saved cursor; nothing is skipped.

TikTok's real limits for these endpoints are not known (V16), so the budget is
a conservative guess.

## Reconnect and missing permissions

- **Expired or revoked authorization.** The access token is refreshed
  automatically. If TikTok rejects the refresh, or the refresh token has
  expired, the connection shows **Reconnect** and the organization's owners
  get an email. Stored comments stay.
- **Missing permission.** If TikTok refuses the video list or a moderation
  action for lack of a scope, the connection is marked as needing reconnection
  and its health shows "Missing permission: video.list. Reconnect and approve
  all requested permissions." (with the scope that was refused). Owners get an
  email. Reconnecting and approving every scope fixes it.
- **One unreadable video** (for example a permission error on its comments)
  is marked unavailable and retried after
  `TIKTOK_SOURCE_UNAVAILABLE_RETRY_SEC` (6 hours). The other videos keep being
  polled and the connection stays active.
- A TikTok outage on this API does not stop the ad connector or other
  platforms.

## Disconnect and retention

Disconnecting stops polling at once and deletes the stored access and refresh
tokens. FeedBouncer also asks TikTok to revoke the token; that call is best
effort, its endpoint is unverified, and a failure never blocks the disconnect.
Comments, decisions and the action log are kept and follow the workspace's
[data retention](../operations/data-retention.md) settings.

## Known limitations

- No direct messages, no LIVE comments, no video editing and no analytics.
- Polling only, so latency is one poll interval at best.
- Hiding a comment does not hide its replies in FeedBouncer, and TikTok's own
  behaviour there is unknown.
- Looking up one comment by id is partial: TikTok has no endpoint for it, so
  FeedBouncer scans the video's newest top-level comments (5 pages). A reply or
  an older comment is not found that way. That is never taken to mean the
  comment was deleted; its state is refreshed by the next poll instead.
- Late replies can take up to 24 hours (the deep scan interval).
- Comments beyond the 2,000-comment backfill cap but within 30 days arrive later
  as new comments, on a deep scan.

## Environment variables

Set these on both the API and the worker unless noted. An empty or unset
polling value uses the default. `.env.example` lists them commented out.

| Variable                                    | Range        | Default | Meaning                                                                                        |
| ------------------------------------------- | ------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `TIKTOK_CONNECTOR_ENABLED`                  | true/false   | `false` | Turns the connector on. `true` requires the two below.                                         |
| `TIKTOK_APP_ID`                             | app id       |         | The TikTok developer app id.                                                                   |
| `TIKTOK_APP_SECRET`                         | 16-128 chars |         | The app secret. `TIKTOK_APP_SECRET_FILE` is supported.                                         |
| `TIKTOK_POLL_INTERVAL_SEC`                  | 60-3600      | 300     | Worker. Poll interval for active videos.                                                       |
| `TIKTOK_QUIET_VIDEO_POLL_INTERVAL_SEC`      | 300-86400    | 21600   | Worker. Poll interval for older videos without recent comments.                                |
| `TIKTOK_ACTIVE_VIDEO_DAYS`                  | 1-365        | 30      | Worker. A video this young polls at the active interval.                                       |
| `TIKTOK_VIDEO_DISCOVERY_INTERVAL_SEC`       | 300-86400    | 900     | Worker. How often the video list is refreshed.                                                 |
| `TIKTOK_DEEP_SCAN_INTERVAL_SEC`             | 3600-604800  | 86400   | Worker. Full re-read of a video, replies included.                                             |
| `TIKTOK_SOURCE_UNAVAILABLE_RETRY_SEC`       | 300-604800   | 21600   | Worker. Retry delay for a video that could not be read.                                        |
| `TIKTOK_MAX_SOURCES_PER_JOB`                | 1-200        | 25      | Worker. Videos polled per job.                                                                 |
| `TIKTOK_MAX_PAGES_PER_JOB`                  | 1-200        | 20      | Worker. Pages read per job (shared with the ad connector); the rest continues in the next job. |
| `TIKTOK_SCHEDULER_TICK_SEC`                 | 5-300        | 30      | Worker. How often due connections are looked for (shared).                                     |
| `TIKTOK_SCHEDULER_MAX_CONNECTIONS_PER_TICK` | 1-5000       | 200     | Worker. Connections enqueued per tick (shared).                                                |

The ad connector's variables are in [tiktok-ads.md](tiktok-ads.md#environment-variables).

When either TikTok connector is enabled, the worker also requires
`PUBLIC_WEB_URL` and `SMTP_URL` (reconnect emails are sent from it) and accepts
`MAIL_FROM`. Either flag set to `true` without its credentials stops the API
and the worker at startup with an error naming the variable. The TikTok
connectors are configured independently of each other and of Facebook.
