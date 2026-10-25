# YouTube connector

Setup, quota budgeting, behaviour and known limitations of the YouTube
connector (`@feedbouncer/connector-youtube`), which moderates comments on a
YouTube channel's own videos through the YouTube Data API v3. For how a
connector fits the framework, see [writing-a-connector.md](writing-a-connector.md).

The connector has no Google SDK. It calls the API through the framework's
`SafeHttp`, and every call is metered against a daily quota (see
[Quota costs](#2-quota-costs)).

## What it covers

One connection is one YouTube channel, in one brand.

- **In:** comment threads and replies on the channel's videos, read by
  polling (there are no webhooks). The channel-wide feed is read every 5
  minutes or more slowly, depending on the remaining budget.
- **Out:** hold for review, publish (the undo of a hold), reject, and reject
  with ban. There is no reply, private reply or unban.

| Step       | YouTube call                                     | Undo from the log |
| ---------- | ------------------------------------------------ | ----------------- |
| Hide       | `comments.setModerationStatus` = `heldForReview` | Unhide            |
| Unhide     | `comments.setModerationStatus` = `published`     | none              |
| Delete     | `comments.setModerationStatus` = `rejected`      | none              |
| Ban author | `rejected` with `banAuthor=true`                 | none              |

"Delete" never calls `comments.delete`: YouTube only lets a comment's author
use it. See [moderation/actions.md](../moderation/actions.md#platform-support).

## 1. Setup

Self-hosters need their own Google Cloud project.

1. Create a project in the Google Cloud console.
2. Enable **YouTube Data API v3** (APIs & Services, Library).
3. Configure the OAuth consent screen and add the scope
   `https://www.googleapis.com/auth/youtube.force-ssl`. The connector uses the
   short name `youtube.force-ssl` internally and sends Google's URL form only in
   the consent URL. This scope is a sensitive scope.
4. Create an OAuth client of type **Web application** and register this
   redirect URI, with your `PUBLIC_WEB_URL` (an origin with no path):

   ```text
   ${PUBLIC_WEB_URL}/api/v1/oauth/youtube/callback
   ```

   The API builds the same URI from `PUBLIC_WEB_URL`
   (`apps/api/src/connector-deps.ts`), and Google must receive it exactly. The
   callback needs the user's FeedBouncer session, so it must be reached on the
   origin the user signed in on.

5. Set the variables below on the API and the worker, then restart both.

| Variable                         | Default | Meaning                                                                                                                     |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_CONNECTOR_ENABLED`      | `false` | `true` turns the connector on. Any other value than `true` or `false` is an error.                                          |
| `YOUTUBE_CLIENT_ID`              | none    | The OAuth client id. Required when enabled; no whitespace, at most 256 characters.                                          |
| `YOUTUBE_CLIENT_SECRET`          | none    | The OAuth client secret, 8 to 256 characters. Required when enabled. May be read from `YOUTUBE_CLIENT_SECRET_FILE` instead. |
| `YOUTUBE_PROJECT_DAILY_QUOTA`    | `10000` | The Google project's daily quota in units, at least 1. Change it only after Google grants more (see section 4).             |
| `YOUTUBE_PROJECT_HEADROOM_UNITS` | `1000`  | Units kept free for other tools on the same project. Must be below the daily quota.                                         |
| `YOUTUBE_SCHEDULER_TICK_SEC`     | `60`    | How often the worker looks for connections whose cycle is due, 10 to 600.                                                   |
| `YOUTUBE_BACKLOG_CAP`            | `5000`  | Most moderation actions queued per connection, 100 to 100000 (see section 5).                                               |

The connector is also listed in `.env.example`. Secrets are never logged and
never appear in error messages or audit details.

**OAuth verification and refresh tokens.** While the Google OAuth consent
screen is in **Testing**, Google expires refresh tokens after 7 days, so every
connection needs to be reconnected weekly, and only listed test users can
connect. Publish the app to **In production** and complete Google's OAuth
verification (a sensitive-scope review, with a privacy policy and a demo
video) before using it with real channels. An expired or revoked grant marks
the connection as needing a reconnect and emails the organization's owners.
The backlog is kept while the connection waits to be reconnected. Reconnecting
asks for consent again (`prompt=consent`, `access_type=offline`), so Google
returns a new refresh token.

The authorising Google user chooses which channel to connect. The connection's
external account id is the channel id (`UC` followed by 22 characters).

## 2. Quota costs

The Data API charges units per call, and the project's quota resets at
midnight Pacific Time. The connector reserves a call's cost before sending it.

| Method                         | Units |
| ------------------------------ | ----- |
| `commentThreads.list`          | 1     |
| `comments.list`                | 1     |
| `channels.list`                | 1     |
| `comments.setModerationStatus` | 50    |

- **Failed calls are charged.** Google charges at least one unit for every
  request, including invalid ones. A call whose outcome is unknown, because of
  a crash or a network error, still counts. Retries are new calls.
- **Each extra page costs the full call again.** A page holds up to 100
  threads.
- **Writes are batched.** `setModerationStatus` takes up to 50 comment ids for
  50 units, so one call moderates up to 50 comments. A batch holds comments
  that share the same status and ban flag.
- **A write batch costs 51 units**: a 1-unit `comments.list` probe, which
  checks that the comments still exist, are unedited and not already
  moderated, plus the 50-unit write.

A day's quota is counted per Pacific calendar day (`America/Los_Angeles`),
including across daylight saving changes.

## 3. Setting a budget

Quota belongs to the Google Cloud project, which is shared by every
organization on the deployment. Every call must therefore fit two limits.

- **The connection's daily budget**, set by an owner or admin on the
  connection's YouTube panel. The default is 2000 units. The maximum is
  `YOUTUBE_PROJECT_DAILY_QUOTA - YOUTUBE_PROJECT_HEADROOM_UNITS`, 9000 by
  default.
- **The project cap**, which is that same difference, and is shared by all
  YouTube connections.

The budget is a hard limit for every call, reads included.

**Read reserve.** Writes may never use the last part of the budget, so
polling keeps working. The reserve is `max(100, ceil(0.15 x budget))`, never
more than the budget: 300 for a 2000 budget. Reads may use everything. The
reserve shrinks as reads spend it.

**Modes.** The panel and `GET .../connections/:id/youtube` show one of these:

| Mode        | When                                                                 | Effect                                                      |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `active`    | At least one write batch (51 units) fits above the read reserve.     | Polling and moderation actions.                             |
| `read_only` | The budget is too low for a write batch above the reserve.           | Polling continues; actions wait in the backlog.             |
| `exhausted` | Nothing is left of today's budget or of the project cap.             | No calls until midnight Pacific; actions wait.              |
| `paused`    | Google answered `quotaExceeded` to any connection on the deployment. | No YouTube calls for any connection until midnight Pacific. |
| `disabled`  | The budget is 0.                                                     | No calls at all.                                            |

A budget of 0 turns the connection off. A low budget leaves it `read_only`:
new comments are still read, but actions wait. At the start of a day, with
nothing spent, a connection needs a budget of at least 151 units to afford one
batch (a reserve of 100 plus 51). Reads spend the reserve first, so the
allowance for writes only shrinks as the day goes on.

**Shared pause.** `quotaExceeded` from Google means the project's quota is
used up, whatever the connection budgets say, so it pauses every YouTube
connection on the deployment until the next Pacific midnight. The owners of
each affected organization get one email per day.

Reads are spread over the day: the poll interval grows from 5 minutes up to 1
hour as the remaining read allowance shrinks, and a connection with too little
allowance left waits for the reset.

### API

All routes need a session and the `connection.read` capability; changing
settings needs `connection.manage`.

- `GET /api/v1/orgs/:orgId/brands/:brandId/connections/:connectionId/youtube`:
  settings (`dailyBudgetUnits`, `dryRun`, `protectedAuthorIds`), limits, today's
  usage and mode, the backlog by tier and the number skipped because of
  overflow.
- `PATCH` on the same path: `dailyBudgetUnits` (integer from 0 to the maximum),
  `dryRun`, `protectedAuthorIds` (at most 200 channel ids). Unknown fields are
  rejected. Each change is written to the audit log as
  `connection.youtube_settings_updated`.
- `GET .../youtube/quota?day=YYYY-MM-DD`: daily totals for one Pacific day, at
  most 90 days back.

Audit details of a YouTube action carry the units spent and the budget
remaining. Comment text never goes into audit details.

## 4. Requesting a higher quota

The default quota is 10,000 units a day, and a connection can use at most
9,000 of it with the default headroom. One 51-unit batch moderates up to 50
comments, so the limit is reached by heavy moderation or many channels. For
more, apply to Google.

1. Open the Google Cloud console, **APIs & Services**, **YouTube Data API
   v3**, **Quotas**, and use the quota extension request.
2. Google runs a YouTube API Services compliance audit and asks you to submit
   the YouTube API Services Audit and Quota Extension form.
3. Prepare:
   - the use case: moderating comments on channels their owners connected;
   - how the app complies with the YouTube API Services Terms of Service and
     Developer Policies, including data handling and revocation;
   - the expected daily units: calls per day, from the costs in section 2
     (reads at 1 unit, one 51-unit batch per 50 moderated comments);
   - screencasts of the OAuth flow and of the moderation features.
4. Once Google approves a larger quota, set `YOUTUBE_PROJECT_DAILY_QUOTA` to
   the new value and restart the API and the worker. Owners can then raise
   their connection budgets up to the new maximum.

Review takes time and the outcome is not guaranteed.

## 5. Priority, backlog, cap and overflow

Hold, reject and ban requests go into a persistent backlog per connection
instead of being sent at once. Each cycle plans what the budget affords. The
backlog survives restarts.

**Priority.** A batch is one status and ban flag, so every batch costs the
same and the order is strict:

1. reject and ban author
2. reject
3. hold for review
4. publish (a person's undo of a hold)

Within a tier the oldest request goes first.

**Planning rules**, applied each cycle:

- Of several queued actions on one comment, only the first by priority is sent.
  The others settle as `superseded`.
- A ban folds in the same author's queued rejects while the batch has room
  (up to 50). They settle as applied with `rejected_with_ban` at no extra cost.
  Holds are never turned into rejects.
- A hold or reject on a reply is skipped as `covered_by_parent` when its parent
  is already deleted, or is being rejected or banned in a batch this cycle
  sends. Rejecting a comment hides its replies. A ban on a reply is never
  skipped this way.
- A hold on a comment that is already held, a reject on a deleted comment and
  an unhide on a published one settle as no-ops (`already_moderated`,
  `already_published`).
- A ban is never sent when the author is the connected channel, is in the
  connection's protected channel ids, or has no channel id on the comment. It
  settles as not eligible (`author_protected`, `author_unavailable`).

**Before a write**, the probe re-reads the comments. One that is gone settles
as `comment_gone`; one edited since FeedBouncer read it settles as
`comment_edited` and is read again, so the rules judge the new text.

**Cap and overflow.** The backlog holds at most `YOUTUBE_BACKLOG_CAP` actions
(default 5000) per connection. Beyond that the actions in the lowest tier, the
newest first, are evicted, so the oldest and most severe are kept. An evicted
action fails with `backlog_overflow`. Because a hold or reject that fails is
flagged for review, nothing is dropped silently. The panel shows how many were
skipped today, and the owners get one email per Pacific day.

**Disconnecting** fails every queued action with `connection_disconnected`.
A connection that needs a reconnect keeps its backlog untouched.

**Protected channel ids.** The Data API cannot list a channel's moderators, so
an owner lists them by hand (channel ids, `UC...`). A ban of a listed channel
is refused and logged as `youtube.ban_protected_author`, with the rule id.

## 6. Dry-run

Turn on **Dry run** in the connection's panel to see what the budget would do.
Planning is the same as in live mode, against a simulated allowance, but no
probe and no write is sent. Each planned action settles as a no-op with the
code `dry_run`, and its audit details record `wouldCostUnits` (51 for the
batch) and `batchSize`. Simulated units are kept in the ledger marked as
simulated and are not counted as spent. Reads are real and charged.

## 7. Limits

- No live chat comments, and no channels other than the ones the user connects
  and owns.
- No unban. Undo a ban in YouTube Studio.
- Reject is not reversible from FeedBouncer: YouTube does not let a rejected
  comment be listed again, and a published or rejected comment cannot go back
  to held.
- Moderators have to be listed by hand as protected channel ids.
- A ban counts as applied only on the API's `204`. After a crash between the
  write and its recording, the ban settles as applied with `ban_unconfirmed`
  and may need checking in YouTube Studio.
- Replies to threads with no activity for more than 7 days are not swept.
  Each sweep checks at most 50 threads for 1 unit.
- A cycle reads at most 5 pages of the feed and 3 pages of replies per thread.
- Comments are plain text only. Author profile links and images are not stored.
- There is no auto-reply or private reply on YouTube.

## 8. Verified behaviour

The behaviour the test double encodes, which still has to be checked against a
real Google project before general availability. Fill in the result column
with the date, the result and who checked it. Every code path handles both
outcomes of (a) and (b).

| #   | Behaviour                                                                                                                   | Result |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| a   | Holding a naturally published comment with `setModerationStatus=heldForReview` is allowed.                                  |        |
| b   | A batch that contains one missing comment id returns 404 for the whole call.                                                |        |
| c   | `comments.list?id=` omits rejected comments, and returns `moderationStatus` for held ones.                                  |        |
| d   | The exact `reason` strings in Google's error responses (`quotaExceeded`, `forbidden`, `notFound`, `commentsDisabled`, ...). |        |

All tests run against a fake of the YouTube API, never the real one.
