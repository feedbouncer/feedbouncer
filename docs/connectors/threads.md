# Threads connector

Setup, permissions, behaviour and known limitations of the Threads connector
(`@feedbouncer/connector-threads`), which moderates replies to a Threads
account's own posts. For how a connector fits the framework, see
[writing-a-connector.md](writing-a-connector.md).

> **Not yet checked against the live Threads API.** No Threads app was
> reachable while this connector was built. The endpoints, the webhook
> signature, error codes and limits it uses come from Meta's documentation or
> are assumptions, and thirteen of them (V1 to V13) are recorded as
> `unverified`. See [Verified behaviour](#verified-behaviour). All tests run
> against a fake of the Threads API, never the real one.

## What it covers

One connection is one Threads account, in one brand.

- **In:** replies to the account's own posts, at any depth. Each reply is
  stored with a link to its post. Replies arrive by webhook wake-up plus
  polling, and by polling alone when webhooks are not configured.
- **Out:** hide and unhide a reply, and a public reply.

Out of scope: private replies (Threads has none), deleting other people's
replies (the API has no such call), banning or blocking authors, posting new
Threads, mentions, direct messages and analytics.

## Connecting an account

An owner or admin of the organization starts the flow from the brand's
Connections page with **Connect Threads account**. The page lists the four
permissions below with what each is for, and marks the two that are required.
FeedBouncer then sends the person to Threads' authorization page with a
single-use `state` bound to their session and brand, and they approve there.

| Permission                | Required | Purpose shown before connecting                                                                                        |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `threads_basic`           | yes      | See your profile and list your posts, so FeedBouncer knows which posts to watch.                                       |
| `threads_read_replies`    | yes      | Read replies to your posts, so your rules can check them. Required.                                                    |
| `threads_manage_replies`  | no       | Hide and unhide replies, and post replies, when your rules say so. Without it, rules can only flag replies for review. |
| `threads_content_publish` | no       | Publish the replies your rules send. Without it, rules can't post replies.                                             |

Declining a required permission means the connection is not created and the
message names what was missing. Declining an optional one connects the account
with fewer abilities:

- Without `threads_manage_replies`, hide, unhide and public reply steps do not
  run. The comment is flagged for review with reason
  `missing_permission:threads_manage_replies`.
- Without `threads_content_publish`, public reply steps do not run
  (flagged for review, `missing_permission:threads_content_publish`). Hide and
  unhide still work.

The connection's health shows declined permissions: "Permission not granted:
&lt;name&gt;. Steps that need it won't run. Reconnect and approve it to turn
them on." Reconnecting and approving the permission fixes it.

After the approval FeedBouncer reads the account (`GET /me`) and shows it for
confirmation; confirming creates the connection. A Threads account can be live
in only one workspace at a time. New connections start in review mode for
7 days: rules still decide, but their hide and reply steps wait as suggestions
for a person to approve. See [review-mode.md](../moderation/review-mode.md).

## Self-hosting: creating the Threads app

Threads uses its own app, separate from the Facebook app that
[Bring your own Meta app](../self-hosting/meta-app.md) sets up. It has its own
app id and secret, and it does not need the Facebook connector to be enabled.

1. In the [Meta developer dashboard](https://developers.facebook.com/apps/),
   create an app (or add to one) and choose the use case **Access the Threads
   API**. Add the four permissions in the table above.
2. Under the Threads settings, copy the **Threads app ID** and **Threads app
   secret**. These are not the Facebook app's ID and secret.
3. Add this **redirect callback URL**, with your `PUBLIC_WEB_URL` (an origin
   with no path, for example `https://app.example.com`):

   ```text
   https://<host>/api/v1/oauth/threads/callback
   ```

   The API builds the same URI from `PUBLIC_WEB_URL`, and Threads must receive
   it exactly. The callback needs the user's FeedBouncer session, so it must be
   reached on the origin the user signed in on.

4. Add the people who will connect as Threads testers on the app while it is in
   development mode. Without Meta's App Review for the permissions, only
   testers can connect. Review can take weeks, so start it early.
5. Set the variables in [Environment variables](#environment-variables) on the
   API and the worker, then restart both. The API and the worker stop at
   startup with an error naming the variable if the flag is `true` and the id
   or secret is missing or malformed.

The exact dashboard labels and the review requirements have not been checked
against a live dashboard and may differ from the steps above.

## Webhooks

Webhooks are optional. They make new replies appear in seconds instead of
within one poll interval.

1. Set `THREADS_WEBHOOK_VERIFY_TOKEN` to a random string of 8 to 256
   characters (`openssl rand -hex 32`) and restart the API. The route
   `/api/v1/webhooks/threads` exists only when the token is set; without it
   the route is off and nothing else changes.
2. In the Threads app's webhooks settings, set the **callback URL** to:

   ```text
   https://<host>/api/v1/webhooks/threads
   ```

   and the **verify token** to the same value as `THREADS_WEBHOOK_VERIFY_TOKEN`.
   Threads sends a verification request to the URL when you save; the API
   answers it with the challenge only if the token matches.

3. Subscribe to the topic **`moderate`** and its field **`replies`**.

Deliveries are signed with the Threads app secret
(`x-hub-signature-256: sha256=<hex>`, an HMAC-SHA256 of the raw body). A
delivery with a missing or wrong signature is rejected and logged as a check
name only. A delivery for an account with no live connection is counted and
dropped. Whether Threads starts sending deliveries for a user as soon as that
user approves `threads_read_replies`, or needs a subscription call, is
unverified (V6), as is the signature format (V4).

Threads sends no webhook when someone else deletes or edits their reply
(see [Limits](#limits)).

## How replies arrive

A webhook does not carry the reply into FeedBouncer by itself. It is a
wake-up:

1. The verified delivery records the reply's id as pending for its post and
   marks the post due. This is written before the API answers, so an API crash
   after the answer loses nothing; a failure answers with an error and Threads
   redelivers.
2. Within about 5 seconds the worker reads that post's conversation. One page
   returns up to 100 replies at any depth, so a burst of notifications for one
   post is read in a few calls instead of one call per reply.
3. Pending ids the pass did not return are looked up one by one (up to 50 per
   pass, 5 attempts each). An id whose lookup says the reply is gone is marked
   deleted.

Polling is the fallback for missed webhooks and the only path when webhooks are
off:

- Active posts (posted in the last 14 days, or with a reply in the last 3 days)
  are re-read every `THREADS_POLL_INTERVAL_SEC` (600 seconds by default). Quiet
  posts are re-read every 6 hours.
- New posts are found every `THREADS_DISCOVERY_INTERVAL_SEC` (900 seconds by
  default).
- Once a day each active post's conversation is read again in full, back to
  the 30-day window. This is how edited replies, which send no webhook, and
  replies older than the poll overlap are picked up. An edit can therefore take
  up to 24 hours to show (V12).
- The first pass after connecting imports the last 30 days of replies, at most
  2,000 per connection. Imported replies are labelled backfilled and rules do
  not act on them.

Without webhooks, latency is one `THREADS_POLL_INTERVAL_SEC` plus the time a
busy queue takes to run the job.

The account's own replies, including the ones FeedBouncer publishes, are
stored but never evaluated by rules. The author of a reply is its @handle;
Threads gives no author id, so author rules match on the handle and a changed
handle is a different author. The `{{author_name}}` template variable renders
the handle.

## Actions

| Action          | Supported | Notes                                                              |
| --------------- | --------- | ------------------------------------------------------------------ |
| Hide / unhide   | yes       | Top-level replies only (below). Not verified against live Threads. |
| Public reply    | yes       | Plain text, at most 500 characters (V8).                           |
| Delete          | no        | The API cannot delete other people's replies.                      |
| Private reply   | no        | Threads has none.                                                  |
| Ban author      | no        | Threads has none.                                                  |
| Flag for review | yes       | Local to FeedBouncer; nothing is sent to Threads.                  |

- **Hide and unhide apply to top-level replies only**, meaning direct replies
  to your post. Hiding one also hides all of its nested replies on Threads,
  and Threads does not let a deeper reply be hidden alone. FeedBouncer does not
  change the stored state of the nested replies, and never hides the parent
  instead. A hide or unhide step on a nested reply is "not supported": the
  reply is flagged for review with reason `hide_nested_reply_unsupported`.
- Only Threads' `HIDDEN` state counts as hidden. `COVERED`, `BLOCKED` and
  `RESTRICTED` are filters by Threads or the viewer, not hides by the owner, so
  those replies are stored as visible and FeedBouncer will not "unhide" them.
- Your own replies are never hidden or evaluated. A public reply to a hidden
  reply is allowed (V11).
- **Replies are plain text, at most 500 characters.** A rule template whose
  longest rendering is over 500 characters is rejected when the rule is saved
  (`template_too_long`). Publishing is two Threads calls, create a container and
  publish it. A crash between them is harmless: an unpublished container
  expires, and a retry looks for the account's own reply with the same text
  before posting again, so it never posts twice.
- One automated reply per thread root, as on every platform.
- Failure reasons shown to the owner come from a table of mapped Threads error
  codes, never Threads' own message text. An unmapped code is shown as
  `threads_error_<code>`.

## Limits

- **1,000 API-published replies per account per rolling 24 hours.** Before each
  reply FeedBouncer reads `threads_publishing_limit`; when the quota is used it
  does not create the reply and defers it 15 minutes. A quota error returned at
  publish time is treated the same way (V10). The comment history shows the
  action as **Delayed until &lt;time&gt;** with the reason "Threads' daily
  reply limit (1,000) reached". After 24 hours of deferral the action fails
  with `rate_limit_exhausted`.
- **Call budget.** Threads allows an app and user pair `4800 x impressions`
  calls per 24 hours, with impressions counted as at least 10: at least 48,000
  a day, about 33 a minute. FeedBouncer budgets 30 calls a minute per
  connection, reserves 8 of them for moderation actions and gives background
  work at most 10. Hides and unhides outrank replies, which use the bulk
  priority, so a reply backlog never delays a hide. A throttled read resumes
  from its saved cursor; nothing is skipped.
- **Tokens last 60 days and refresh themselves.** FeedBouncer stores the
  long-lived token and refreshes it with itself, about 7 days before it
  expires. Threads only refreshes a token that is at least 24 hours old and
  not yet expired. Reads and polling keep the refresh timely.
- **No webhook for others' deletions or edits.** A reply that its author
  deleted is noticed when a lookup says it is gone, when a hide, unhide or
  reply on it finds it missing, or never if nothing touches it. Absence from a
  listing never marks a reply deleted, because conversations are paged and
  filtered. Edits are picked up by the daily full re-read.
- Comments beyond the 2,000-reply backfill cap but within 30 days arrive later
  as new replies.

## Reconnect and missing permissions

- **Expired or revoked authorization.** If a refresh is rejected, or any call
  answers an authentication error, FeedBouncer retries once and then marks the
  connection **Reconnect**, pauses its actions and emails the organization's
  owners. Stored replies stay, and pending actions run after the account is
  reconnected.
- **Missing permission.** If Threads refuses the post list for lack of
  `threads_basic`, the connection needs reconnecting and its health names the
  scope. If it refuses a hide or reply for lack of a permission, the scope is
  recorded as declined and shown in the health text.
- **One unreadable post** is marked unavailable and retried later. The others
  keep being polled.
- A Threads outage does not stop the other platforms.

## Disconnect and retention

Disconnecting stops polling at once and deletes the stored tokens. Threads has
no revoke call, so the app stays in the person's Threads settings until they
remove it there. Webhook deliveries for the account afterwards are counted and
dropped. Replies, decisions and the action log are kept and follow the
workspace's [data retention](../operations/data-retention.md) settings;
pending webhook records go with the connection.

## Known limitations

- Hide and unhide on top-level replies only.
- Replies up to 500 characters of plain text, 1,000 a day.
- Author identity is the @handle, which can change.
- Deletions and edits by others are found late (above).
- No private replies, no deletes of others' replies, no bans, no DMs.

## Environment variables

Set these on both the API and the worker unless noted. An empty or unset
polling value uses the default. `.env.example` lists them commented out.

| Variable                         | Range       | Default | Meaning                                                                                         |
| -------------------------------- | ----------- | ------- | ----------------------------------------------------------------------------------------------- |
| `THREADS_CONNECTOR_ENABLED`      | true/false  | `false` | Turns the connector on. `true` requires the app id and secret.                                  |
| `THREADS_APP_ID`                 | digits      |         | The Threads app id (not the Facebook app id).                                                   |
| `THREADS_APP_SECRET`             | 8-256 chars |         | The Threads app secret. `THREADS_APP_SECRET_FILE` is supported.                                 |
| `THREADS_WEBHOOK_VERIFY_TOKEN`   | 8-256 chars | unset   | Optional. Enables `/api/v1/webhooks/threads`. `THREADS_WEBHOOK_VERIFY_TOKEN_FILE` is supported. |
| `THREADS_POLL_INTERVAL_SEC`      | 60-3600     | 600     | Worker. Poll interval for active posts, and the delay without webhooks.                         |
| `THREADS_DISCOVERY_INTERVAL_SEC` | 300-21600   | 900     | Worker. How often the account's post list is refreshed.                                         |

When the connector is enabled, the worker also requires `PUBLIC_WEB_URL` and
`SMTP_URL` (reconnect emails are sent from it) and accepts `MAIL_FROM`. The
Threads connector is configured independently of Facebook and of the other
platforms.

## Verified behaviour

Thirteen assumptions (V1 to V13) cover the authorization host, the code
exchange, how granted permissions are read, the webhook signature and payload
shape, how deliveries start, token transport, the reply length limit, error
codes, the reply-quota error, replying to a hidden reply, edit detection and
whether a user's own replies are returned as posts. The table, with what
changes if each is wrong, is in the
[`connector-threads` README](../../packages/connector-threads/README.md#verified-behaviour-v10-checked-2026-10-25).

**All of V1 to V13 are unverified.** None has been checked against a live
Meta test app. Until each is, treat the behaviour above that depends on it
(marked with its number) as expected, not confirmed.
