# Instagram connector

Setup, permissions, behaviour and known limitations of the Instagram connector
(`@feedbouncer/connector-instagram`), which signs in with Facebook Login. For
the code, see [the package README](../../packages/connector-instagram/README.md).
For how a connector fits the framework, see
[writing-a-connector.md](writing-a-connector.md). It shares its Meta app, its
sign-in flow and its webhook secret with the [Facebook connector](facebook.md).

> **Verification status.** No Meta test app was available when this connector
> was written, so none of the platform behaviour it depends on has been
> observed. Eight questions (V1 to V8 in the package README) are marked
> `unverified`. Where this page describes one of them, it says so. Treat those
> statements as assumptions until the table in the README is filled in.

## What it does

New comments on an Instagram Business or Creator account that is linked to a
Facebook Page come in, and four kinds of action go out.

- **In:** new comments and replies, through the `comments` webhook. Each event
  is re-read from the Graph API before it is stored, so what is stored is what
  Instagram reports now.
- **Out:** hide and unhide, delete, public reply, and private reply (a direct
  message sent in answer to a comment).

Out of scope:

- Instagram Login without a Facebook Page (the "Instagram API with Instagram
  Login" product), and personal Instagram accounts.
- Mentions, story replies, live comments and direct messages other than the one
  private reply per comment.
- Banning an author (Instagram has no such API).
- Importing comments posted before the account was connected, or while it was
  disconnected (no backfill).

## Prerequisites

- The Instagram account must be a **Business** or **Creator** account.
- It must be **linked to a Facebook Page**. In Meta Business Suite, open
  Settings, then Instagram accounts, and connect the account to the Page.
- The person connecting must have **full control or moderation access** to that
  Page (the `MODERATE` task). A Page where they lack it is shown greyed out
  with "You need full control or moderation access to this Page".

The connect flow lists the Facebook Pages the person manages and, for each,
the Instagram account linked to it. A Page with no linked account is shown
greyed out with "No Instagram professional account is linked to this Page" and
cannot be selected. If none of the person's Pages has a linked account the
picker says so and nothing is connected. A Page that lacks the `MESSAGING`
task is not a problem: the account connects, and private replies are marked
unavailable.

## Meta app setup

Use the **same Meta app** as the Facebook connector. If you have not created it
yet, follow [facebook.md](facebook.md#create-the-meta-app) first.

1. Add the **Instagram** product, using **API setup with Facebook Login**
   (not "with Instagram Login").
2. Under Facebook Login, add this **Valid OAuth Redirect URI**, with your
   `PUBLIC_WEB_URL`:

   ```text
   ${PUBLIC_WEB_URL}/api/v1/oauth/instagram/callback
   ```

   This is in addition to the Facebook one. The API and the worker must have
   the same `PUBLIC_WEB_URL`.

3. Under Webhooks, choose the **Instagram** object (not Page) and set the
   callback URL to:

   ```text
   ${PUBLIC_WEB_URL}/api/v1/webhooks/instagram
   ```

   with the verify token set to the value of `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.
   Subscribe to the `comments` field. Meta requires HTTPS for the callback.

4. Keep **Require App Secret** on. FeedBouncer sends `appsecret_proof` with
   every Graph call.

As with Facebook, the Page itself is subscribed to the app by FeedBouncer, not
by hand: connecting an account queues a `connection_lifecycle` job that adds
the `comments` field to the Page's subscription.

## Environment variables

| Variable                                  | Required  | Meaning                                                                                                                       |
| ----------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_CONNECTOR_ENABLED`             | to enable | `true` turns the connector on, `false` or unset leaves it off. Set it on the API and on the worker.                           |
| `FACEBOOK_APP_ID`                         | yes       | The Meta app id. Required: Instagram runs on the Facebook app. Enabling Instagram without it fails startup.                   |
| `FACEBOOK_APP_SECRET`                     | yes       | The Meta app secret, at least 16 characters. `FACEBOOK_APP_SECRET_FILE` is supported.                                         |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN`           | yes       | Echoed by Meta in the webhook handshake. At least 20 characters. `FACEBOOK_WEBHOOK_VERIFY_TOKEN_FILE` is supported.           |
| `FACEBOOK_GRAPH_API_VERSION`              | no        | Graph API version, `vNN.0` form. Default `v26.0`. Shared with the Facebook connector.                                         |
| `JOB_CONCURRENCY_INSTAGRAM`               | no        | Jobs run in parallel for this platform. `0` turns the Instagram consumer off. See [job-queue.md](../operations/job-queue.md). |
| `CONNECTOR_STALE_AFTER_SECONDS_INSTAGRAM` | no        | How long without a successful sync before health is degraded. See [observability.md](../operations/observability.md).         |

The Facebook variables are required because the app, its secret and its
webhook signature are shared. Enabling Instagram does not need the Facebook
connector to be in use for any Page.

The local compose stack passes `INSTAGRAM_CONNECTOR_ENABLED` through to the
`api` and `worker` services with no default. Never commit secrets;
`.env.example` lists the variables commented out.

## Permissions requested and why

| Permission                  | Needed for                                                               | Required |
| --------------------------- | ------------------------------------------------------------------------ | -------- |
| `instagram_basic`           | The account id and username.                                             | yes      |
| `instagram_manage_comments` | Reading, hiding, deleting and replying to comments; commenter usernames. | yes      |
| `pages_show_list`           | Listing your Pages, with a Page access token for each.                   | yes      |
| `pages_read_engagement`     | Reading comments through the linked Page.                                | yes      |
| `pages_manage_metadata`     | Subscribing the Page to comment webhooks.                                | yes      |
| `instagram_manage_messages` | Private replies.                                                         | no       |

Declining a required permission ends the connection with a message naming what
was missing, and no connection is created. Declining `instagram_manage_messages`
connects the account without private replies: the picker shows "Private
replies won't be available", and a private reply later reports that it needs
the messaging permission.

**V2 (unverified):** whether a private reply works without
`instagram_manage_messages` was not tested. FeedBouncer requests it anyway and
treats it as optional. If Meta turns out to require it, the permission becomes
mandatory for private replies only. If Meta turns out not to need it, the
request can be dropped.

**Pages whose role was granted through Business Manager.** Meta also requires
`ads_read` for people who have access to the Page that way. This connector does
not request `ads_read` yet, so such Pages may fail with a permission error
(shown as "Needs reconnect" with `permission_revoked`). This is not confirmed
against a live app.

## App Review, Business Verification, and development mode

- Using the permissions above for people outside your own team needs
  **Advanced Access**, which needs App Review and Business Verification of the
  business that owns the app. The `comments` webhook also needs Advanced Access
  and Business Verification.
- **In development mode, comments from people who have no role on the app may
  not be delivered, and private replies only reach people who have a role on
  the app.** A comment that does not arrive while the app is in development
  mode is not a bug in FeedBouncer. Test with comments written by the app's
  admins, developers or testers.
- Whether App Review asks for `instagram_manage_messages` separately for
  private replies depends on V2 above.
- **Status of this deployment:** App Review has not been completed for the
  reference configuration. Treat the connector as development-mode until your
  own app is approved.

## How it works

### Connecting

1. An owner or admin starts the flow from the brand's Connections page, which
   sends them to Facebook's authorization dialog (the same dialog and the same
   PKCE and single-use `state` handling as the Facebook connector) with the
   Instagram permissions above.
2. The callback exchanges the code and checks the granted permissions. Missing
   required permissions end the flow with `missing_permissions`.
3. The user token is sealed in a short-lived single-use grant, bound to that
   user, brand and platform, and the user is sent to the picker.
4. The picker lists every Page the person manages with its linked Instagram
   account. Selecting an account connects it. The web app sends the chosen
   ids as `accountIds` in the connect request. The Page access token is what is
   stored, encrypted. A `connection_lifecycle` job subscribes the Page.

One Instagram account can be live in only one workspace across the whole
deployment, enforced by a unique index. An account that is already live
elsewhere is refused with "This Instagram account is already connected in
another FeedBouncer workspace".

Reconnecting goes through the same flow, started from the existing connection.
It updates the token in place on the same record, so history and waiting work
are kept and no duplicate is created.

### Receiving comments

- `GET /api/v1/webhooks/instagram` answers Meta's handshake when the verify
  token matches.
- `POST` of the same path is the delivery. It must carry a valid
  `X-Hub-Signature-256` over the exact bytes received, made with the app
  secret. Anything unsigned or mis-signed gets 403.
- A verified delivery is de-duplicated by the SHA-256 of its body. Each
  `comments` change is routed to the one live connection for that Instagram
  account and becomes a `comment_ingest` job. The response is sent without
  waiting for the job. Events for an account with no live connection are
  dropped and counted in the `webhook.unrouted_events` log line. Events for
  live media (`LIVE`) are ignored.
- If handing the events to the queue fails, the endpoint answers 503, so Meta
  redelivers the delivery rather than the events being lost.
- The ingest job re-fetches the comment from Graph, so a stale or replayed
  event cannot overwrite newer state, and stores it idempotently. Replies are
  linked to their parent. State is monotonic: a deleted comment stays deleted.
- Comments on ads are stored like organic ones for now.
- While a connection needs reconnecting, events are still accepted and the
  jobs wait and run once it is reconnected.

### Acting

Actions are requested by any member who can moderate (`comment.moderate`) from
the comment list. Each request carries a `requestKey`, so a retried request
returns the same action record rather than acting twice. Every attempt is
recorded with its actor, target, outcome and time, and run by a
`moderation_execute` job.

- **Availability** is decided by the server from the stored comment and the
  connector's constraints, before anything is sent to Instagram, and the
  comment list shows the same answer per action. An unavailable action is
  disabled with a reason, such as "Instagram always shows your own comments,
  so they can't be hidden".
- Hide, unhide and delete run against the comment. Delete asks for
  confirmation. Replies are plain text.
- A request that is allowed starts as `pending`. It becomes `applied` when
  Instagram confirms, `not_eligible` when Instagram refuses for a policy
  reason, or `failed` when it cannot be completed. The interface never shows
  success until the action is `applied`.
- Rate limits and transient errors are retried with backoff and the action
  stays `pending`. A permanently refused action is recorded as `failed` with
  its outcome code.
- A reply to a reply is posted on the top-level comment, because Instagram
  threads are one level deep.
- A public reply that is retried after a crash first looks for the account's
  own earlier reply by exact text, so it is not posted twice.

### Resync after a refused action

When Instagram refuses an action for a reason that means FeedBouncer's copy of
the comment is out of date (the comment is gone, or the platform says a reply
is not eligible, or a permanent refusal), FeedBouncer queues a re-read of that
comment through the normal ingest job. This is how a comment hidden or deleted
in the Instagram app is caught up. If queueing the re-read fails, the action
outcome is still recorded and the worker logs `moderation.resync_not_queued`
with the action id.

### Disconnecting

Disconnecting (owner or admin) revokes the connection locally at once and
queues a teardown job that removes the `comments` field from the Page's
subscription and deletes the stored token. The Page's subscription is
changed by field, so a Facebook connection on the same Page keeps its `feed`
field (see [Shared Pages](facebook.md#shared-pages)). Stored comments and the
action history stay. The teardown is best-effort on the Instagram side: if the
token no longer works, the local credentials are still removed.

## Known Instagram limits

Assumptions that have **not been verified against a live Meta app** (see the
README table):

- **V1, subscription field:** that `POST /{page}/subscribed_apps` accepts
  `subscribed_fields=comments` and that Instagram comment webhooks then arrive
  for the linked account. If Meta wants a different field, the Page
  subscription fails or no comments arrive. The fallback would be to subscribe the Page to `feed`
  and keep that field in place, which is a contingency only and is not
  implemented.
- **V4, hide request shape:** that hide and unhide accept `hide=true|false` as
  a form body. Graph may require it in the query string.
- **V3, error codes:** the mapping from Graph `code` and `error_subcode` to
  "already replied", "window closed", "nested comment" and "reply to a hidden
  comment" is assumed. A refusal that is not mapped shows as a failed action
  (`instagram_error_<code>_<subcode>`) instead of not eligible.
- **V7, reply length:** the limits are assumed to be 2200 characters for a
  public reply and 1000 for a private reply (counted in code points). Longer
  text is refused by FeedBouncer before sending.
- **V2:** whether `instagram_manage_messages` is required for private replies.
- **V6, V8:** that `media{id,permalink}` expands on a comment, and whether our
  own reply triggers a `comments` webhook (the ingest job is idempotent either
  way).

Known platform limits the code applies:

- **Private reply:** once per comment, within 7 days of the comment being
  posted, and only to top-level comments.
- **No reply to hidden comments.** Unhide the comment first.
- **The account's own comments cannot be hidden.** Instagram always shows them.
- **No ban API.** Ban and unban are not offered.
- **Hidden or deleted in the Instagram app.** Instagram sends no event when a
  comment is hidden or deleted there, so FeedBouncer catches up the next time
  someone acts on that comment (see Resync).
- **Live comments** are ignored.
- **Ad comments** are stored like organic ones for now. They are not treated
  differently, and Instagram may impose different rules on them.
- **No backfill** and no catch-up poll. A comment posted while the connection
  was down is not imported.
- Meta's deauthorize and data-deletion callbacks are not implemented.

## Data retention

Stored comments and the action history are kept after a connection is
disconnected. Tokens are deleted. How this lines up with the data-deletion
page is an open question, owned by the Phase 3 retention item.

## Troubleshooting

**A connection shows "Needs reconnect".** Instagram rejected the Page token
(`token_expired`, for example it expired or the person changed their password),
FeedBouncer lost a permission (`permission_revoked`), or the person no longer
has a moderator role on the Page (`page_role_lost`: "You no longer have a
moderator role on this Page"). A stored credential that cannot be read also
causes it (see [secrets.md](../operations/secrets.md)). The organization's
owners are emailed once per transition. Actions pause and their jobs wait. An
owner or admin reconnects from the Connections page with a person who still
manages the Page and grants the required permissions; waiting work is replayed.

**An action ended as `instagram_error_<code>_<subcode>`.** Instagram refused
with an error the connector does not recognize; the numbers are Graph's `code`
and `error_subcode`. `instagram_account_restricted` means Instagram has
restricted the account; resolve it in the Instagram app. Please report
unrecognized codes, since they are what V3 needs.

**Comments do not arrive.**

- In development mode, only comments from people with a role on the app may be
  delivered. See above.
- Check that the app's `Instagram` webhook object is subscribed to `comments`,
  and that the account is linked to the Page. Reconnecting re-queues the Page
  subscription.
- Check the `webhook.unrouted_events` log line: events for an account with no
  live connection are dropped.
- Check connector health for `rate_limited`, and the histogram
  `feedbouncer_comment_ingest_lag_seconds`. Meta throttles per app and per
  account; FeedBouncer backs off and keeps the work queued.

**Webhook deliveries get 403.** The signature did not verify. Almost always
`FACEBOOK_APP_SECRET` does not match the app that sends the webhooks (or a
proxy altered the body). A 403 on the `GET` handshake means the verify token
differs from `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.

**Connecting says the account is already connected.** An Instagram account can
be live in only one workspace. Disconnect it there first.

**The picker is empty or a Page is greyed out.** The person lacks the
`MODERATE` task on the Page, or the Page has no linked Instagram professional
account, or the Page is visible only through a Business Manager (see
permissions).
