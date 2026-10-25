# @feedbouncer/connector-threads

Threads API connector, built on `SafeHttp` with no Meta SDK. This package currently holds the request layer; the connector itself is added on top of it.

- `config.ts`: scopes and their purposes, rate-limit policy, scheduling constants, `ThreadsConfig` and `parseThreadsEnv` (`THREADS_CONNECTOR_ENABLED`, `THREADS_APP_ID`, `THREADS_APP_SECRET`, optional `THREADS_WEBHOOK_VERIFY_TOKEN`, `THREADS_POLL_INTERVAL_SEC`, `THREADS_DISCOVERY_INTERVAL_SEC`).
- `api.ts`: `threadsPath`, a closed table of paths whose only variable segment is a numeric id checked before any I/O, and `threadsRequest`. Every token goes in a bearer header. Two values are in the query string because the API requires it: `client_secret` on `th_exchange_token` and `input_token` on `debug_token`. `threadsRequest` never logs, throws or stores a URL. POST bodies are form encoded. Errors carry a code only: never the URL, query string, response body or Meta's message.
- `errors.ts`: `mapThreadsError` and `THREADS_ERROR_TABLE`, keyed on the Graph `error.code` and `error_subcode`; anything else falls back to the HTTP status.
- `ids.ts`: strict validators for media ids, handles, cursors, permalinks and timestamps, and `sanitizeText`.

## Verified behaviour (v1.0, checked 2026-10-25)

No Threads app was reachable when this was written, so every row is `unverified`. The code follows the primary assumption of each row; apply the fallback when the row is verified.

| #   | Question                                                                                                                       | Result     | Code path affected                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| V1  | Authorization host is `threads.com` (fallback `threads.net`; both are allowed)                                                 | unverified | `AUTHORIZE_URL` in `oauth.ts`                                      |
| V2  | `POST /oauth/access_token` form `{client_id, client_secret, grant_type, redirect_uri, code}` returns `{access_token, user_id}` | unverified | `SHORT_TOKEN_SCHEMA` in `oauth.ts`                                 |
| V3  | `debug_token` with the user's long-lived token as both tokens returns `scopes` for any user                                    | unverified | granted scopes in `oauth.ts` (fallback: `scopes = THREADS_SCOPES`) |
| V4  | Webhook signature is `x-hub-signature-256: sha256=<hex HMAC-SHA256(rawBody, app secret)>`                                      | unverified | `THREADS_SIGNATURE` in `webhook.ts`                                |
| V5  | Webhook `values` is an object; an array (at most 100) is also accepted                                                         | unverified | `parseThreadsWebhook`                                              |
| V6  | Deliveries start automatically once the user grants `threads_read_replies` to an app subscribed to `moderate/replies`          | unverified | `lifecycle.onConnected` (fallback: add a subscription call)        |
| V7  | `Authorization: Bearer <token>` is accepted by `graph.threads.net`                                                             | unverified | `threadsRequest` (fallback: `access_token` query parameter)        |
| V8  | Reply text limit is 500 characters                                                                                             | unverified | `THREADS_MAX_REPLY_CHARS` in `config.ts`                           |
| V9  | Error codes: 190/102 auth; 4/17/32/613 throttle; 100 + subcode 33 not found; 10 and 200-299 permission                         | unverified | `THREADS_ERROR_TABLE` in `errors.ts`                               |
| V10 | The reply-quota error on publish is code 4 or subcode 2207051                                                                  | unverified | `THREADS_ERROR_TABLE` in `errors.ts`                               |
| V11 | A reply to a hidden reply is allowed                                                                                           | unverified | `constraints.publicReplyOnHidden` (fallback: `false`)              |
| V12 | Edits send no webhook; an edited `text` appears on re-read                                                                     | unverified | daily full re-read (docs only)                                     |
| V13 | `/me/threads` returns posts but not the user's own replies                                                                     | unverified | `listSources` (fallback: filter `is_reply === true`)               |
