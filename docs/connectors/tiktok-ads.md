# TikTok ads connector

Setup, permissions, behaviour and known limitations of the TikTok ads
connector (`@feedbouncer/connector-tiktok-ads`), which moderates comments on a
TikTok advertiser's ads through the TikTok Marketing API. Comments on a TikTok
account's own videos are a separate connector: see [tiktok.md](tiktok.md). For
how a connector fits the framework, see
[writing-a-connector.md](writing-a-connector.md).

> **Not yet checked against the live TikTok API.** No TikTok developer app
> with sandbox access was available while this connector was built. The
> Marketing API endpoints it uses are the documented ones, but their exact
> parameters, token lifetime, rate limits and error codes, and whether delete
> and reply work on other people's comments, are unverified assumptions. The
> list, with what changes if an assumption is wrong, is in
> [the `tiktok-business-api` README](../../packages/tiktok-business-api/README.md#verified-behaviour-api-v13-checked-2026-10-24)
> (rows V10 to V20 concern this connector). All tests run against a fake of the
> TikTok API, never the real one.

## What it covers

One connection is one TikTok advertiser (ad account), in one brand. One
authorization can connect several advertisers to the same brand; each becomes
its own connection.

- **In:** comments and replies on the advertiser's ads, read by polling one
  advertiser-wide comment list. Each comment is stored with an **Ad** label
  and the ad it was posted on. The ad links to its video
  (`https://www.tiktok.com/@/video/<video id>`); whether that link resolves is
  unverified (V20).
- **Out:** hide, unhide and delete a comment, and a public reply.

Out of scope: creating, editing or pausing ads, ad analytics and reporting,
direct messages, LIVE comments, and comments on the account's organic videos
(see [tiktok.md](tiktok.md)).

## Create the TikTok developer app

1. Create a developer app on the TikTok for Business developer portal with
   Marketing API access, or add Marketing API access to the app you use for
   [the organic connector](tiktok.md#create-the-tiktok-developer-app). By
   default this connector uses the same app id and secret as the organic one
   (`TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`); set `TIKTOK_ADS_APP_ID` and
   `TIKTOK_ADS_APP_SECRET` to use a separate app. Whether one app can serve
   both products is unverified (V18).
2. Register this redirect URI, with your `PUBLIC_WEB_URL`:

   ```text
   ${PUBLIC_WEB_URL}/api/v1/oauth/tiktok_ads/callback
   ```

3. Ask for the comment management permission (below) and submit the app for
   review.

Expect TikTok to review the app before advertisers outside your own business
can authorize it. Review can take weeks, so start it early. The exact portal
steps, and what TikTok's review asks for, have not been checked.

## Permissions

The Marketing API has no OAuth scope strings. Permissions are granted to the
app by TikTok and then authorized per advertiser, so FeedBouncer requests none
by name at connect time and finds a missing permission only when a call is
refused.

The app needs the **comment management** permission group, to read, hide,
delete and reply to ad comments. When TikTok refuses a call for lack of it,
FeedBouncer names it `comment_management` (see
[Reconnect and missing permissions](#reconnect-and-missing-permissions)).

## Connect steps

1. An owner or admin of the organization chooses **Connect TikTok ads** on the
   brand's Connections page. FeedBouncer sends them to TikTok's advertiser
   authorization page with a single-use `state` bound to their session and
   brand.
2. They authorize the app for one or more advertisers on TikTok. Cancelling
   there returns to the Connections page with nothing connected.
3. TikTok redirects back with an `auth_code`. FeedBouncer exchanges it for a
   token and lists the advertisers it can act for.
4. They pick the advertisers whose ads belong to this brand. Each picked
   advertiser becomes a connection; the others are not stored. To add an
   advertiser later, connect again and pick it.
5. Polling starts at the next scheduler tick.

PKCE is not sent to TikTok: whether its advertiser authorization accepts it
is unverified (V11). The flow relies on the session-bound single-use `state`
and the exact redirect URI instead.

The same advertiser can be connected in more than one workspace, for example
when two organizations share it through a TikTok Business Center. Each
workspace gets its own copy of the comments.

New connections start in review mode for 7 days. See
[review-mode.md](../moderation/review-mode.md).

## Supported actions

From the connector's capabilities (`TIKTOK_ADS_ACTIONS` and
`TIKTOK_ADS_RESPONSES`):

| Action          | Supported | Notes                                                                                                  |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| Hide / unhide   | yes       | Unverified against live TikTok. The name of the body field that carries the state is unverified (V14). |
| Delete          | yes       | Unverified against live TikTok: deleting other people's ad comments is assumed to be allowed (V15).    |
| Public reply    | yes       | Unverified against live TikTok: replying to other people's ad comments is assumed to be allowed (V15). |
| Private reply   | no        | TikTok has no API for it.                                                                              |
| Ban author      | no        | TikTok has no API for it.                                                                              |
| Flag for review | yes       | Local to FeedBouncer; nothing is sent to TikTok.                                                       |

If TikTok turns out not to allow delete or reply on ad comments, they are
removed from the connector, and rules that use them then flag for review as
described below.

## Unsupported actions go to manual review

When a rule's step cannot run on a TikTok ad comment, FeedBouncer never
substitutes another action. The comment is **flagged for review** and the
decision carries the reason:

- `action_not_supported:tiktok_ads:<step>` when TikTok does not offer the
  step, for example `action_not_supported:tiktok_ads:ban`. The review queue
  shows "TikTok ads don't support ban author; review manually."
- `missing_permission:comment_management` when the advertiser has not granted
  the permission the step needs.

This applies on every platform, not only TikTok.

## Latency

Comments arrive by polling only. TikTok sends no webhooks for ad comments.

- A new comment on any of the advertiser's ads appears within one
  `TIKTOK_ADS_POLL_INTERVAL_SEC` (5 minutes by default), plus the time a busy
  queue takes to run the job.
- Each poll reads the advertiser's comments newest first, back to the newest
  comment of the last completed pass less `TIKTOK_ADS_POLL_OVERLAP_SEC`
  (15 minutes). The overlap means a comment that moved across a page boundary
  while a pass was running is read again by the next one, so none is skipped.

## Backfill

The first pass after connecting imports the last 30 days of ad comments, at
most 2,000 per connection. Imported comments are labelled as backfilled and
rules do not act on them.

## Replies

Replies come in the same listing as top-level comments, each with its parent,
so they arrive at the same latency.

FeedBouncer never hides replies because their parent was hidden. Whether
TikTok hides the replies of a hidden comment itself is unknown (V17).

## Ended and paused ads

Every `TIKTOK_ADS_FULL_SCAN_INTERVAL_SEC` (24 hours by default) a pass re-reads
the whole 30-day window. That refreshes the hidden or deleted state of comments
on ads that have ended or are paused. A comment TikTok stops returning keeps its
last known state: it is never marked deleted just because it is absent.

## Spark Ads

A Spark Ad promotes an organic video, so its comments can be listed both here
and by the organic connector. They are kept as two separate threads, one per
connection. They are never merged, replies are only linked to parents in their
own thread, and each copy is moderated through its own API.

## Rate limits and throttling

Each advertiser connection has its own request budget (60 requests a minute by
default, with 10 kept back for moderation actions), separate from the organic
connector's and from every other platform. Polling runs at background
priority. A TikTok throttle (error code 40100 or HTTP 429) defers the pass,
which resumes from its saved page; nothing is skipped and the high-water mark
only moves once a pass completes. A large comment list is read across several
jobs (`TIKTOK_MAX_PAGES_PER_JOB`).

TikTok's limit is assumed to be about 10 requests a second per app and
advertiser, which is unverified (V16); the default budget stays well below it.

## Reconnect and missing permissions

- **Token expiry.** TikTok may issue advertiser tokens that do not expire, or
  tokens that last 24 hours with a refresh token (V12). Both are handled: a
  token without an expiry is never refreshed, and one with an expiry is
  refreshed automatically. Advertisers connected from one authorization each
  keep their own copy of the token and refresh it independently. When TikTok rejects the token or the refresh, the
  connection shows **Reconnect** and the organization's owners get an email.
- **Missing permission.** When TikTok refuses the comment list or an action
  for lack of permission, the connection is marked as needing reconnection and
  its health shows "Missing permission: comment_management. Reconnect and
  approve all requested permissions." Owners get an email.
- A Marketing API outage does not stop the organic connector or other
  platforms.

## Disconnect and retention

Disconnecting one advertiser stops its polling at once and deletes its stored
tokens. The Marketing API has no revoke endpoint, so nothing is sent to TikTok;
remove the app's access on TikTok's side if you want TikTok to forget the
authorization too. Other advertisers and the organic connection are not affected. Comments,
decisions and the action log are kept and follow the workspace's
[data retention](../operations/data-retention.md) settings.

## Known limitations

- No ad creation or editing, no analytics, no direct messages and no LIVE
  comments.
- Polling only, so latency is one poll interval at best.
- Comments on ended or paused ads show their last known state between full
  scans, and after TikTok stops returning them.
- Looking up one comment by id searches the last 30 days only, so an older
  comment is not found that way. That is never taken to mean it was deleted.
- Whether the ad's video link resolves on TikTok is unverified.

## Environment variables

Set these on both the API and the worker unless noted. `.env.example` lists
them commented out.

| Variable                            | Range        | Default             | Meaning                                                          |
| ----------------------------------- | ------------ | ------------------- | ---------------------------------------------------------------- |
| `TIKTOK_ADS_CONNECTOR_ENABLED`      | true/false   | `false`             | Turns the connector on. `true` requires an app id and secret.    |
| `TIKTOK_ADS_APP_ID`                 | app id       | `TIKTOK_APP_ID`     | The Marketing API app id.                                        |
| `TIKTOK_ADS_APP_SECRET`             | 16-128 chars | `TIKTOK_APP_SECRET` | The app secret. `TIKTOK_ADS_APP_SECRET_FILE` is supported.       |
| `TIKTOK_ADS_POLL_INTERVAL_SEC`      | 60-3600      | 300                 | Worker. Poll interval per advertiser.                            |
| `TIKTOK_ADS_POLL_OVERLAP_SEC`       | 0-86400      | 900                 | Worker. How far before the last high-water mark a pass re-reads. |
| `TIKTOK_ADS_FULL_SCAN_INTERVAL_SEC` | 3600-604800  | 86400               | Worker. Full re-read of the 30-day window.                       |

`TIKTOK_MAX_PAGES_PER_JOB`, `TIKTOK_SCHEDULER_TICK_SEC` and
`TIKTOK_SCHEDULER_MAX_CONNECTIONS_PER_TICK` are shared with the organic
connector and listed in [tiktok.md](tiktok.md#environment-variables).

When either TikTok connector is enabled, the worker also requires
`PUBLIC_WEB_URL` and `SMTP_URL` and accepts `MAIL_FROM`. The flag set to
`true` without an app id and secret (its own or the organic connector's) stops
the API and the worker at startup with an error naming the variable. This
connector works without the organic one and without Facebook.
