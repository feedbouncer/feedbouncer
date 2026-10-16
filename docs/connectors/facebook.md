# Facebook Pages connector

Setup, permissions, behaviour and known limitations of the Facebook Pages
connector (`@feedbouncer/connector-facebook`). For the code, see
[the package README](../../packages/connector-facebook/README.md). For how a
connector fits the framework, see [writing-a-connector.md](writing-a-connector.md).

## What it does

Organic comments on a Facebook Page's posts come in, and five kinds of action
go out. Nothing else.

- **In:** new, edited, hidden and removed comments (including replies), through
  the Page `feed` webhook. Each event other than a delete is re-read from the Graph
  API before it is stored, so what is stored is what Facebook reports now;
  delete events are stored without a re-read.
- **Out:** five actions: hide (and unhide), delete, ban (and unban) the
  comment's author, public reply, and private reply (a Messenger message sent
  in answer to a comment).

Out of scope:

- Ads ("dark post") comments, and comments on other platforms. Instagram is
  a separate connector: see [instagram.md](instagram.md).
- Posting, scheduling or editing posts, reading insights, and inbox
  conversations other than the one private reply per comment.
- Importing comments posted before a Page was connected, or while it was
  disconnected. A Page's recent comments are imported once when it is
  connected; see [backfill.md](backfill.md).
- Facebook Login for personal profiles. Only Pages the signed-in person manages
  are listed.

## Create the Meta app

1. In the [Meta for Developers](https://developers.facebook.com/) dashboard,
   create an app of the **Business** type.
2. Add the **Facebook Login for Business** product (or **Facebook Login**) and
   the **Webhooks** product.
3. Under Facebook Login, add this **Valid OAuth Redirect URI**, with your
   `PUBLIC_WEB_URL` (an origin with no path, for example
   `https://app.example.com`):

   ```text
   ${PUBLIC_WEB_URL}/api/v1/oauth/facebook/callback
   ```

   The API and the worker build the same redirect URI from `PUBLIC_WEB_URL`,
   so both must have the same value. The callback requires the user's
   FeedBouncer session, so the browser must reach it on the same origin it
   signed in on.

4. Under Webhooks, choose the **Page** object and set the callback URL to:

   ```text
   ${PUBLIC_WEB_URL}/api/v1/webhooks/facebook
   ```

   and the verify token to the value of `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.
   Subscribe to the `feed` field. The route is served by the API. The web app
   forwards `/api/v1/*` to it with the body and the `X-Hub-Signature-256`
   header intact, so the web origin works. If you expose the API on its own
   host, use that host instead. There is no separate public API URL setting.
   Meta requires HTTPS for the callback.

5. Turn on **Require App Secret** (Settings, Advanced). FeedBouncer sends
   `appsecret_proof` with every Graph call, so this is safe to require.

The Page itself is subscribed to the app by FeedBouncer, not by hand: connecting
a Page queues a `connection_lifecycle` job that subscribes it to the `feed`
field, and disconnecting queues the matching unsubscribe.

## Environment variables

| Variable                        | Required        | Meaning                                                                                                                    |
| ------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `FACEBOOK_APP_ID`               | to enable       | The numeric Meta app id. Unset (or empty) means the connector is off: no routes, no jobs, `platform_not_configured` (404). |
| `FACEBOOK_APP_SECRET`           | with the app id | The Meta app secret, at least 16 characters. `FACEBOOK_APP_SECRET_FILE` is supported.                                      |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | with the app id | Echoed by Meta in the webhook handshake. At least 20 characters. `FACEBOOK_WEBHOOK_VERIFY_TOKEN_FILE` is supported.        |
| `FACEBOOK_GRAPH_API_VERSION`    | no              | Graph API version, `vNN.0` form. Default `v26.0`.                                                                          |

Both the API and the worker need the app id and secret. The API also needs the
verify token for the handshake. Set all three on both so a deployment has one
configuration. The app secret also verifies webhook signatures, so it must be
the secret of the app that sends the webhooks.

When Facebook is configured the worker also requires `SMTP_URL` and
`PUBLIC_WEB_URL` (reconnect notices are emailed from it; without Facebook they
are not needed), and accepts `MAIL_FROM`. The local compose stack
passes the `FACEBOOK_*` variables through to the `api` and `worker` services
with no defaults and points the worker at the Mailpit dev sink.

Never commit these values. `.env.example` lists them commented out.

## Permissions requested and why

FeedBouncer asks for exactly these six permissions and needs all of them.
Declining any one aborts the connection with a message naming what was
missing. No partial connection is created.

| Permission                | Needed for                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- |
| `pages_show_list`         | Listing the Pages the person manages, with a Page access token for each.          |
| `pages_read_engagement`   | Reading a Page's posts and the comments, replies and author ids on them.          |
| `pages_read_user_content` | Reading comments written by users on the Page's posts.                            |
| `pages_manage_engagement` | Hide and unhide, delete, public replies, and banning or unbanning an author.      |
| `pages_manage_metadata`   | Subscribing the Page to the app's `feed` webhook (and removing the subscription). |
| `pages_messaging`         | Private replies to comments.                                                      |

Which rule steps need which permission, and what happens when one is missing,
is in [actions.md](../moderation/actions.md#platform-support).

The person connecting must also hold Page tasks that allow it. A Page is
offered as connectable only when its tasks include `MODERATE` (required for
everything), and private replies additionally need `MESSAGING`. A Page that
lacks `MESSAGING` can still be connected for the other actions; its private
replies report as not eligible.

## App Review and Business Verification

- All six permissions need **Advanced Access**, which needs App Review and
  Business Verification of the business that owns the app.
- Until the app is approved, only people with a role on the app (admin,
  developer or tester) can connect Pages, and private replies can only reach
  people with a role on the app.
- Private replies are reviewed under `pages_messaging`. Whether Meta asks for a
  separate review step for them is not confirmed; check in the submission.
- **Status of this deployment:** App Review has not been completed for the
  reference configuration. Treat the connector as development-mode until your
  own app is approved.

## How it works

### Connecting

1. An owner or admin of the organization (the `connection.manage` capability)
   starts the flow from the brand's Connections page. FeedBouncer sends them to
   Facebook's authorization dialog with PKCE and a single-use `state`. A
   pending flow lives 10 minutes.
2. The callback exchanges the code for a long-lived user token and checks the
   granted permissions. Missing permissions end the flow with
   `missing_permissions`.
3. The user token is sealed in a short-lived **grant** (envelope kind
   `oauth_grant_token`, 30 minutes) and the user is sent to the Page picker.
   The grant is single-use and bound to that user, brand and platform.
4. The picker lists every Page the user manages, marking Pages that cannot be
   connected and why (a Page already connected elsewhere, or one without the
   `MODERATE` task). Selecting Pages connects each one. The grant
   is consumed, so a second submit starts again.
5. Each connected Page gets its own connection, storing that Page's token
   encrypted. A `connection_lifecycle` job subscribes the Page to the webhook.

One Facebook Page can be live in only one workspace (brand) across the whole
deployment, enforced by a unique index. Connecting a Page that is already live
elsewhere is refused for that Page.

Reconnecting a connection that needs it (see Troubleshooting) goes through the
same flow, started from that connection. It updates the token in place and
does not create a duplicate. Work that was waiting runs again afterwards.

### Receiving comments

- `GET /api/v1/webhooks/facebook` answers Meta's subscription handshake when
  the verify token matches, and returns the challenge as plain text.
- `POST` of the same path is the delivery. The body must carry a valid
  `X-Hub-Signature-256` over the exact bytes received, made with the app
  secret. Anything unsigned or mis-signed gets 403 and is dropped.
- A verified delivery is de-duplicated by the SHA-256 of its body. Each event
  is routed to the single live connection for its Page and becomes a
  `comment_ingest` job; the HTTP response is sent without waiting for the job.
  An event for a Page with no live connection is dropped and counted in the
  `webhook.unrouted_events` log line.
- The job re-fetches the comment from Graph (so a stale webhook cannot
  overwrite newer state) and stores it. Nested replies are linked to their
  parent. State is monotonic: a deleted comment stays deleted, and an older
  fetch never overwrites a newer one.
- While a connection is waiting for reconnect, events are still accepted and
  their jobs are held and run again once it is reconnected, so no event is
  lost.

### Acting

Actions are requested by any member who can moderate (`comment.moderate`; this
includes the `member` role) from the comment list. Each request carries a
`requestKey`, so a retried request returns the same action record rather than
acting twice. Every attempt is recorded with its actor, target, outcome and
time, and run by a `moderation_execute` job.

- Acting on a comment that is already gone, or already in the requested state,
  is recorded as a no-op.
- A private reply is allowed once per comment and only within 7 days of the
  comment being posted. Outside that, or when Facebook refuses, the action is
  recorded as `not_eligible` with a reason.
- Replies are plain text, 1 to 8000 characters. A reply to a reply is posted
  on the top-level comment, because Facebook threads are one level deep.
- A Page's own comments are never moderated automatically, and the Page can
  never be banned as an author.

### Disconnecting

Disconnecting (owner or admin) revokes the connection locally at once and
queues a teardown job that unsubscribes the Page from the webhook and deletes
the stored token. Stored comments and the action history stay. The teardown is
best-effort on the Facebook side: if the token no longer works, the local
credentials are still removed.

## Known limitations

The first group are behaviours the code assumes but that have **not been
verified against a live Meta app**. The table in the
[package README](../../packages/connector-facebook/README.md#verified-behaviour)
is the log; update it when you test.

- **PKCE:** the authorization request sends `code_challenge`, and the code
  exchange sends `code_verifier`. Whether Facebook Login honours PKCE is
  unverified. State and the app secret bind the flow either way.
- **Authorization header:** access tokens are sent as `Authorization: Bearer`
  only, never in a URL. That Graph accepts this for GET, POST and DELETE is
  unverified. There is no URL fallback.
- **Page token expiry:** the code assumes a Page token obtained from a
  long-lived user token does not expire. If Meta expires it, the connection
  will move to reconnect-required rather than refresh.
- **Private-reply error codes:** the mapping from Graph `code` and
  `error_subcode` to "already replied", "window closed" and "author
  unavailable" is assumed, not observed. An unmapped refusal shows as a
  failed action instead of not eligible.
- **Banning an author:** ban and unban use `/{page}/blocked` with the
  commenter's id. Facebook may not accept every commenter id type (for
  example, users who only appear to the app under a page-scoped id).
  When it refuses, the action reports `author_not_bannable`. Ban-by-author may
  be unsupported in your configuration.

Other limits:

- Backfill is limited. Connecting a Page imports the last 30 days of comments
  on its recent posts, and reconnecting fetches only the outage gap; see
  [backfill.md](backfill.md). Older comments are not imported. Ad posts are
  polled (see [meta-ads.md](meta-ads.md)); organic posts are otherwise
  webhook-only.
- Graph calls beyond comments: `GET /{page-id}/feed` lists the Page's recent
  posts for backfill (read-only, no extra scope).
- Comments on ads (dark posts) arrive through the Meta Ads connector, which
  reads them with this Page's connection.
- Shared Pages: see below.
- Meta's deauthorize and data-deletion callbacks are not implemented.
- Pages that are reachable only through a Business Manager may need the
  `business_management` permission, which FeedBouncer does not request. If a
  Page you manage is missing from the picker, that may be why.
- A public reply that is retried after a crash is matched to the earlier
  attempt by exact text within a 60 second window. Two identical manual
  replies inside that window may be merged in FeedBouncer's records.
- Only one comment nesting level is modeled; see Acting.
- Roles: a `member` can moderate comments. Only an `owner` or `admin` can
  connect, reconnect or disconnect a Page.

## Shared Pages

A Page can be connected here and, through its linked Instagram account, to the
[Instagram connector](instagram.md). Both use the same Meta app, and a Meta app
has one webhook subscription per Page whose `subscribed_fields` list is
replaced as a whole on every write. FeedBouncer therefore reads the current
list and merges by field: this connector adds and removes `feed`, the Instagram
connector adds and removes `comments`, and the subscription is deleted only
when no field is left. Disconnecting one platform does not stop the other.

## Troubleshooting

**A connection shows "Needs reconnect".** Facebook rejected the Page token
(expired, revoked, the person lost the Page role, or removed the app), or a
stored credential could not be read (see
[secrets.md](../operations/secrets.md)). The organization's owners are sent an
email once per transition. Actions pause and their jobs wait. An owner or admin
reconnects from the Connections page; waiting work is replayed on success.
Reconnect with a person who still manages the Page and grants all six
permissions.

**Comments arrive late or not at all.**

- Check connector health for `rate_limited`, and the histogram
  `feedbouncer_comment_ingest_lag_seconds`. Meta throttles per app and per
  Page; FeedBouncer backs off and keeps the work queued.
- Confirm the Page is subscribed: reconnect re-queues the subscription.
- Check the `webhook.unrouted_events` log line: events for a Page with no live
  connection are dropped.

**Webhook deliveries get 403.** The signature did not verify. Almost always
`FACEBOOK_APP_SECRET` does not match the app that sends the webhooks (or a
proxy altered the body). A 403 on the `GET` handshake means the verify token
differs from `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.

**Connecting says the Page is already connected.** A Page can be live in only
one workspace. Disconnect it there first.

**The picker is empty or a Page is greyed out.** The person does not manage
the Page with the `MODERATE` task, or declined a permission, or the Page is
visible only through a Business Manager (see limitations).
