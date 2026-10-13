# @feedbouncer/connector-facebook

Facebook Pages connector for the FeedBouncer connector framework: OAuth, Page
listing, organic comment moderation and webhooks, built on
[`@feedbouncer/connectors`](../connectors/README.md).

## Modules

| File               | Responsibility                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config.ts`    | `parseFacebookEnv`, `FACEBOOK_SCOPES`, `FACEBOOK_FILE_VARS`. Returns `null` when `FACEBOOK_APP_ID` is unset.                                                 |
| `src/graph.ts`     | The only HTTP path to Graph: `graphRequest`, `graphId` path guard, `appSecretProof`, `mapGraphError`, BUC usage.                                             |
| `src/oauth.ts`     | `buildAuthorizationUrl`, `exchangeCode` (short- to long-lived user token), `listAccounts` (Pages the user manages with their Page tokens).                   |
| `src/comments.ts`  | `listComments`, `getComment`, `toNormalizedComment`: read and normalize Page post comments.                                                                  |
| `src/webhook.ts`   | `facebookWebhookSpec` (HMAC signature, feed event `parseFeedWebhook`), `verifyHandshake` (subscribe challenge).                                              |
| `src/actions.ts`   | `act` (hide, unhide, delete, ban/unban author), `respond` (public and private replies), `lifecycle` (feed webhook subscription), `PRIVATE_REPLY_INELIGIBLE`. |
| `src/connector.ts` | `createFacebookConnector`: the `Connector` for the framework registry (tokens not refreshable, multiple Page selection).                                     |
| `src/testing/`     | `./testing` export: `FakeGraph`, an in-memory Graph API (Pages, tokens, comments, webhooks) for tests of this package and its consumers.                     |

## Rules enforced here

- Access tokens travel only in the `Authorization: Bearer` header. They are never
  placed in a URL or query string. `appsecret_proof` (HMAC-SHA256 of the token
  keyed with the app secret) is the only credential-derived value in a query.
- Every id from Graph or a webhook must match `GRAPH_ID` (one to three numeric
  segments joined by `_`, e.g. `<page>_<post>_<n>` for comments) before it is
  used in a path. Anything else is `permanent/invalid_graph_id`, before any I/O.
- Errors are mapped from numeric `code`/`error_subcode` only. The Graph error
  `message` is never read, logged or carried.

## Verified behaviour

**Status: UNVERIFIED.** The four behaviours below have not been checked against
a live Meta app. The code implements the documented defaults. Check each against
a development-mode Meta app and a test Page you administer (Graph API Explorer
or curl), then record the date and result here.

| #   | Behaviour                                                                                                                                                                                                     | Status     | What to check                                                                                                                                    | If it fails                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) | PKCE on the Facebook Login dialog: `code_challenge` (S256) is accepted and the code exchange accepts `code_verifier`.                                                                                         | UNVERIFIED | Open `https://www.facebook.com/v26.0/dialog/oauth` with `code_challenge`/`code_challenge_method=S256`, then exchange the code with the verifier. | If the verifier is rejected or the challenge ignored: keep sending `code_challenge` (harmless), omit `code_verifier` in `exchangeCode`, and comment that state and client secret bind the flow. |
| (b) | Graph accepts `Authorization: Bearer <token>` for GET, POST and DELETE.                                                                                                                                       | UNVERIFIED | `GET https://graph.facebook.com/v26.0/me` with the Bearer header, and one POST and one DELETE on a test comment.                                 | Stop and escalate. There is no URL-token fallback: tokens are never sent in a query string or logged URL.                                                                                       |
| (c) | A short-lived user token exchanges via `grant_type=fb_exchange_token`; `GET /me/accounts` returns Page tokens; `GET /debug_token?input_token=<page token>` reports `expires_at: 0` (non-expiring Page token). | UNVERIFIED | Perform the exchange, list accounts, then debug the Page token. Send `client_secret` and the exchange token in a POST form body only.            | If Page tokens expire: add refresh handling and record the observed lifetime before shipping; do not assume non-expiring tokens.                                                                |
| (d) | Private reply to a comment older than 7 days, and a second private reply to the same comment, are rejected with distinguishable `code`/`error_subcode`.                                                       | UNVERIFIED | Send a private reply to an 8-day-old comment, and a second one to the same comment. Record `code`/`error_subcode` for each.                      | Adjust `PRIVATE_REPLY_INELIGIBLE` to the observed values.                                                                                                                                       |

### Private-reply ineligibility codes (UNVERIFIED)

`PRIVATE_REPLY_INELIGIBLE` in `src/actions.ts` maps Graph errors from
`POST /{page-id}/messages` to `not_eligible` reasons. The values are assumed,
not observed. Replace them with what behaviour (d) records.

| `code` | `error_subcode` | Reason                        | Status     |
| ------ | --------------- | ----------------------------- | ---------- |
| 10900  | any             | `private_reply_already_sent`  | UNVERIFIED |
| 10     | 2018278         | `private_reply_window_closed` | UNVERIFIED |
| 551    | any             | `author_unavailable`          | UNVERIFIED |
| 100    | 2018001         | `author_unavailable`          | UNVERIFIED |
