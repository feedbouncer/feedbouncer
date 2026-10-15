# Writing a connector

A connector turns one platform's HTTP API into the `Connector` contract from
`@feedbouncer/connectors`. Everything around it (tenancy, token storage,
refresh, budgets, signatures, dedupe, output validation) belongs to the
framework. The reference connector in
[`packages/connectors/src/reference/connector.ts`](../../packages/connectors/src/reference/connector.ts)
is the template; the excerpts below are lines from it.

## Overview

| Concern                                           | Framework                                          | Connector                        |
| ------------------------------------------------- | -------------------------------------------------- | -------------------------------- |
| Tenancy (org, brand, connection)                  | Every query and key carries the full scope         | Nothing                          |
| Token storage and encryption                      | `CredentialVault` over the encrypted secrets store | Return a `TokenSet`              |
| Refresh serialization, rotation write order       | `TokenManager`                                     | `refreshTokens` only             |
| OAuth state, PKCE, session binding, authorization | `OAuthFlow`                                        | Build the URL, exchange the code |
| Request budget, urgent reserve, platform hints    | `RateBudget`, `ConnectionClient`                   | Map 429 and report quota         |
| Webhook signature, timestamp window, dedupe       | `WebhookGate`                                      | Declare a `WebhookSpec`, parse   |
| Validating what comes back                        | Zod schemas on every return value                  | Return normalized values         |
| Translating platform JSON and errors              | Nothing                                            | Everything                       |

The moderation core only ever uses `ConnectorRuntime` and `ConnectionClient`.
It never calls a connector directly.

The framework ships no HTTP routes. The API app owns them (OAuth start and
callback, the account picker, the webhook receiver); `OAuthFlow` checks brand
membership and the `connection.manage` capability itself, so a route cannot
skip it. The Facebook routes in `apps/api` are the worked example.

## Declaring capabilities

Features are exposed through `ConnectorCapabilities`. Do not widen
`Connector` to add platform-specific methods; add a capability and a runtime
check instead.

| Field                            | Meaning                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `actions`                        | The `ModerationAction`s the platform can do. Others return `unsupported` without a call.        |
| `listSources`                    | `true` exactly when the connector implements `listSources`.                                     |
| `ingestion`                      | `webhook`, `polling` or `webhook_and_polling`. Anything but `polling` needs `webhook`.          |
| `tokens.refreshable`             | The platform issues refresh tokens.                                                             |
| `tokens.rotatesRefreshToken`     | Every refresh returns a new refresh token (implies `refreshable`).                              |
| `rateLimit`                      | `points` per `durationSec` per connected account, `urgentReservePoints`, `defaultRetryAfterMs`. |
| `apiHosts`, `authorizationHosts` | Exact lowercase hostnames. `SafeHttp` and the authorization URL check are limited to them.      |
| `defaultScopes`                  | Scopes requested at connect time.                                                               |
| `maxPageSize`                    | 1 to 500. The runtime clamps `limit` to it.                                                     |

`validateConnector` runs at registration and throws on: an unknown platform,
duplicate or unknown actions, a rate limit outside its bounds (`points` 1 to
1,000,000, `durationSec` 1 to 86,400, `urgentReservePoints` below `points`,
`defaultRetryAfterMs` 1,000 to 86,400,000), empty or malformed host lists, a
page size outside 1 to 500, rotation without refresh, `listSources` that
disagrees with the capability, a `webhook` that disagrees with `ingestion`, a
malformed signature header name, and a `toleranceSec` outside 1 to 600 when a
timestamp header is used.

The reference connector declares:

```ts from=reference/connector.ts
capabilities: {
  actions,
  listSources: false,
  ingestion: push ? 'webhook' : 'polling',
  tokens: { refreshable: true, rotatesRefreshToken: push },
  rateLimit: {
    points: 20,
    durationSec: 60,
    urgentReservePoints: 5,
    defaultRetryAfterMs: 10_000,
  },
  apiHosts: ['api.reference.test'],
  authorizationHosts: ['auth.reference.test'],
  defaultScopes: ['comments'],
  maxPageSize: push ? 50 : 3,
},
```

A connector is a plain object built by a factory. Client id and secret are
factory arguments (the secret as a `Secret`), supplied by the app from its own
configuration. A connector never reads `process.env`; a lint rule in the
package enforces that.

```ts
import type { Secret } from '@feedbouncer/service-runtime';
import { ConnectorError, type Connector } from '@feedbouncer/connectors';

export function createMyPlatformConnector(config: {
  clientId: string;
  clientSecret: Secret;
  redirectUri: string;
}): Connector {
  // capabilities, OAuth, reads, act, webhook ...
}
```

## OAuth

Implement three methods. `OAuthFlow` generates the state and the PKCE pair and
stores them; you only place them in the URL.

`buildAuthorizationUrl` must carry `state` verbatim, send `codeChallenge` with
`code_challenge_method=S256`, and point at a host in `authorizationHosts`.
`OAuthFlow.start` refuses a URL whose `state` parameter differs or whose host
is not allowed.

```ts from=reference/connector.ts
buildAuthorizationUrl: ({ state, codeChallenge, redirectUri, scopes }) => {
  const u = new URL('https://auth.reference.test/authorize');
  u.search = new URLSearchParams({
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
  }).toString();
  return u;
},
```

`exchangeCode` receives the authorization code and the PKCE verifier as
`Secret`s and returns the `TokenSet` plus the `AuthorizedAccount` (the
platform's stable account id and a display name). Reveal a secret only in the
call that sends it.

```ts from=reference/connector.ts
async exchangeCode({ code, codeVerifier }, ctx) {
  const t = wrap(() =>
    api.tokenEndpoint({
      kind: 'code',
      code: code.reveal(),
      codeVerifier: codeVerifier.reveal(),
      redirectUri: ctx.redirectUri,
    }),
  );
  return {
    tokens: toTokens(t),
    account: { externalAccountId: t.accountId, displayName: `Account ${t.accountId}` },
  };
},
```

What the framework does around it:

- State is 32 random bytes, base64url. Only its SHA-256 is stored. It is single
  use, bound to the user, brand and platform that started the flow, and expires
  after 10 minutes in the app (the database caps any state lifetime at one
  hour, which assumes app and database clocks agree to within about 50
  minutes).
- The PKCE verifier is stored envelope-encrypted under the
  `oauth_pkce_verifier` kind.
- A callback from another session is rejected without consuming the real
  user's state. Replays, unknown or expired state, and a missing or malformed
  code all produce the same opaque `rejected`. A malformed code is refused
  before the state is consumed, so the user can still finish.
- `OAuthFlow.complete` returns typed non-ok results (`denied`,
  `account_mismatch`, `platform_error`, `connection_inactive`). A `revoked`
  connection is terminal: it is never reactivated. A `revoked` or `paused`
  connection gets `connection_inactive` and no tokens are stored.

## Multi-account authorization (`accountSelection`, `listAccounts`)

By default one authorization yields one account: `exchangeCode` returns it and
`OAuthFlow.complete` connects it. Some platforms grant several accounts at once
(Facebook: every Page the person manages, each with its own token). Declare
`accountSelection: 'multiple'` and implement `listAccounts`.

- `exchangeCode` still returns a `TokenSet` (here, the user token) and an
  `AuthorizedAccount` for the person who authorized.
- `OAuthFlow.complete` then stores the user token as a grant, sealed under
  the `oauth_grant_token` envelope kind and bound to the user, brand and
  platform, and returns `kind: 'account_selection'` with a grant id instead of
  connecting anything. The grant is single use and lives 30 minutes by default
  (`grantTtlMs`).
- `listAccounts(userToken, ctx)` returns a `GrantableAccount` per account the
  token can act for: the platform id, a display name, the account's own
  `accessToken`, whether it is `eligible` (with an `ineligibleReason` code when
  not) and any `limitations` (snake_case codes for things that work only
  partly, such as `no_messaging_task`). It is called when the picker is shown
  and again when accounts are connected, and is never cached.
- `OAuthFlow.listGrantAccounts` and `OAuthFlow.connectAccounts` back the picker
  and the connect step. Each chosen account becomes its own connection with its
  own encrypted token. A result per account reports `connected`,
  `reconnected`, `not_eligible`, `not_found`, `connected_elsewhere` or
  `connection_inactive`.
- A platform account can be live in only one workspace. The directory's
  `findLiveByAccount` (the one cross-tenant lookup) reports it so the picker
  can mark it, and the connect step enforces it.

Set `tokens.refreshable: false` when the account tokens do not refresh. An
access token the platform rejects then moves the connection to
`reconnect_required` instead of attempting a refresh.

## Required scopes

`defaultScopes` is what the authorization asks for. `requiredScopes` is the
subset without which the connection is unusable, and must be listed in
`defaultScopes` (`validateConnector` checks). When the platform reports what was
actually granted, `OAuthFlow.complete` compares it with `requiredScopes` and, if
any is missing, ends the flow with `missing_permissions` and the missing names,
storing no tokens. The names are the connector's own, never platform text, so
they are safe to show. A connector that does not set `requiredScopes` accepts
whatever was granted.

## Token refresh

`refreshTokens` receives the stored refresh token and returns a new
`TokenSet`.

- Return `refreshToken: null` when the platform does not rotate. The stored
  refresh token is kept.
- When the platform rejects the grant (`invalid_grant`), throw
  `ConnectorError('auth_expired', 'invalid_grant')`. The framework flags the
  connection `reconnect_required` once and stops; there is no retry loop.
- Throw `transient` or `rate_limited` for retryable failures. Never retry
  inside the connector.

```ts from=reference/connector.ts
async refreshTokens(rt) {
  return toTokens(
    wrap(() => api.tokenEndpoint({ kind: 'refresh', refreshToken: rt.reveal() })),
  );
},
```

The framework guarantees, so you do not implement any of it:

- Refresh is single-flight per connection within a process (keyed on the full
  tenant scope) and serialized across processes by a Postgres session-level
  advisory lock on a dedicated lock pool, not the data pool.
- A waiter re-reads the vault inside the lock and reuses a token another
  process just stored.
- A rotated refresh token is written first, in its own committed write, before
  the access token. A failure in between leaves a valid refresh token. The
  small window between the platform's answer and that first commit cannot be
  closed.
- Refresh refuses connections that are not `active`.
- Every `TokenSet` (from `exchangeCode` too) is checked before anything is
  stored. Tokens must be `Secret`s and `scopes` at most 100 strings of up to
  256 characters without control characters; otherwise the call fails with
  `permanent` / `invalid_connector_output`. An invalid expiry is stored as
  `null` (unknown) instead of failing, so a rotated refresh token is never
  lost.
- Access tokens count as expired 120 seconds before `accessTokenExpiresAt`.

## Reading

`listComments(ctx, { sourceExternalId, cursor, limit })` returns a `Page` of
`NormalizedComment`s; `getComment` returns one or `null`. `listSources` is
optional and tied to the `listSources` capability.

- Cursors are opaque to the core: 1 to 2048 characters, no control
  characters. `nextCursor: null` ends the listing.
- A comment deleted between pages must not fail the listing. Skip it and
  return what still exists. A comment that is gone from `getComment` is `null`
  (or a thrown `not_found`, which the runtime turns into `null`).
- Use `ctx.http` (a `SafeHttp`) for every request, including "next page" URLs
  the platform hands you. It is https only, rejects userinfo and ports, limits
  hosts to `apiHosts`, does not follow redirects, caps responses at 2 MiB and
  never includes URLs or bodies in its errors.
- Always pass `ctx.signal` to `ctx.http.request`. The per-call timeout is
  delivered through that signal; the runtime does not race your operation.
- Call `ctx.reportQuota({ remaining, resetAt })` when the platform returns
  quota headers. A report lowers the local budget to the platform's number;
  `remaining <= 0` defers further calls until `resetAt` (at most 24 hours).
  Reporting is best-effort: it never rejects, even when the budget store is
  down, so it cannot fail your call.

Everything returned is validated by strict zod schemas. Unknown keys, ids over
255 characters or with control characters, non-https URLs, bodies over
100,000 characters, more than 500 items, or an invalid `Date` fail the call
with `invalid_connector_output`. Duplicate ids within a page are dropped.

```ts from=reference/connector.ts
const toComment = (c: RefComment): NormalizedComment => ({
  externalId: c.id,
  sourceExternalId: c.sourceId,
  parentExternalId: null,
  author: { externalId: c.authorId, displayName: c.authorName, profileUrl: null },
  body: c.body,
  postedAt: new Date(c.postedAt),
  platformState: c.state,
  permalink: `https://www.reference.test/c/${c.id}`,
});
```

## Listing recent sources (`listRecentSources`)

`listRecentSources(ctx, { since, cursor, limit })` is optional and tied to the
`recentSources` capability. It returns a `Page<RecentSource>` of the account's
own posts or media, newest first, each with `externalId`, `createdAt` and
`permalink`. The comment backfill job walks these sources and then reads each
one with `listComments`.

- Set `capabilities.recentSources` to `true` exactly when you implement it.
  Without it the runtime throws an `unsupported` error without any I/O, and
  backfill does not run for that platform.
- Items older than `since` may be skipped, but a pinned or backdated old post
  at the top must not end the listing early; stop when a page's last item is
  older than `since`.
- Follow the same cursor, validation and `ctx.http` rules as `listComments`.
  Do not follow `paging.next` URLs; build requests yourself.
- Backfill calls use `background` priority, the lowest, so they never delay actions or webhook fetches.
  See [backfill.md](backfill.md).

## Acting

`act(ctx, { action, target })` returns `{ status: 'applied', platformActionId }`
or `{ status: 'not_found' }`.

- Content that has vanished is `not_found`, either returned or thrown. The
  core sees `ActionResult.status === 'not_found'`; `isSuccessEquivalent` treats
  that as success for `delete`.
- Repeating an action that is already in effect (hiding a hidden comment)
  is `applied`.
- You never build `undo`. The runtime sets it from `INVERSE_ACTION` when the
  inverse is in your declared `actions`, and to `null` otherwise.
- Actions your capabilities do not list return `unsupported` before any
  platform call. `ConnectionClient.act` never throws for platform outcomes.
- Replies are not actions. See "Replies (`respond`)".

```ts from=reference/connector.ts
async act(ctx, req) {
  const r = wrap(() =>
    api.api(ctx.accessToken.reveal(), 'act', (acct) =>
      api.apply(acct, req.target.sourceExternalId, req.target.externalId, req.action),
    ),
  );
  return r === 'applied'
    ? { status: 'applied', platformActionId: null }
    : { status: 'not_found' };
},
```

## Action constraints (`capabilities.constraints`)

Whether an action can apply to a stored comment is decided once, in the
moderation core, from the stored comment and your capabilities. It runs before
any platform call, records the up-front outcome, and is also what the comment
list shows as per-action availability. Platforms differ, so declare their rules
in `capabilities.constraints`. Every member is optional, and absent means the
Facebook-like default.

| Member                     | Default       | Meaning                                                                                       |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| `privateReplyWindowMs`     | 7 days        | How long after posting a private reply is allowed.                                            |
| `privateReplyTopLevelOnly` | `false`       | Private replies to nested comments are `private_reply_nested_comment`.                        |
| `publicReplyOnHidden`      | `true`        | `false` refuses public replies to hidden comments (`reply_to_hidden_comment`).                |
| `hideOwnAccountComments`   | `true`        | `false` refuses hide and unhide of the account's own comments (`own_comment_always_visible`). |
| `maxReplyChars`            | 8000 per kind | Maximum code points per response kind. Longer text is `reply_too_long`.                       |

Constraints are for rules you know in advance. A refusal that only the
platform can decide still comes back from `respond` as `not_eligible`.

## Replies (`respond`)

Replies are a separate method from `act`, because they send user-written text
and have platform eligibility rules that are not errors. Declare which kinds
the platform supports in `capabilities.responses` (`public_reply`,
`private_reply`) and implement `respond(ctx, req)`.

- `req` is a `RespondRequest`: the kind, a `CommentRef` target and plain text.
  The framework validates it first (1 to 8000 characters after trim, no NUL)
  and never calls the connector with anything else. Send it as plain text; the
  UI renders it as text too.
- Return `{ status: 'sent', platformRef }`, `{ status: 'not_found' }` when the
  comment is gone, or `{ status: 'not_eligible', code }` when the platform
  refuses for a policy reason: the window closed, already replied, the author
  cannot be messaged. The code is a snake_case reason, not platform text.
  Never retry inside `respond`.
- A kind you do not declare returns `unsupported` before any platform call.
- `PRIVATE_REPLY_WINDOW_MS` (7 days) is the shared private-reply window the
  moderation core checks before it calls you.
- Calls are urgent priority and use the same budget as `act`.

## `listReplies`

Some platforms do not expose replies through
`listComments({ sourceExternalId: commentId })`. Implement the optional
`listReplies(ctx, { parent, cursor, limit })` to return the replies under one
comment, with the same paging and validation rules as `listComments`. The
runtime returns `null` without any I/O when it is absent.

The moderation core uses it to recover a public reply after a crash: on a
retry it lists the parent's most recent replies and looks for the account's own
reply with the same text, so that a reply that did succeed is recorded and not
posted a second time.

## Webhooks

Declare `webhook: WebhookSpec` when `ingestion` is not `polling`.

| Field                       | Meaning                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `signature.header`          | Header carrying the HMAC-SHA256 digest.                                                                |
| `signature.prefix`          | Literal prefix before the digest (`sha256=`), may be empty.                                            |
| `signature.encoding`        | `hex` or `base64`.                                                                                     |
| `signature.timestampHeader` | Header with the signed timestamp in epoch seconds, or `null` if the platform has none.                 |
| `signature.signedPayload`   | Builds the exact bytes the platform signed from the raw body and the timestamp.                        |
| `toleranceSec`              | Accepted clock distance for the timestamp, 1 to 600. Required with a timestamp header; omit otherwise. |
| `secretSource`              | `app` (one secret per platform app) or `connection` (a secret per connected account).                  |
| `parse`                     | Turns a verified raw body into `InboundEvent`s.                                                        |

Choose `connection` when the platform signs with a per-account secret. Events
in a delivery signed with a connection's own secret but naming another account
are dropped and logged, so one tenant cannot inject events for another.

```ts from=reference/connector.ts
webhook: {
  secretSource: 'app',
  signature: {
    header: 'x-ref-signature',
    prefix: 'sha256=',
    encoding: 'hex',
    timestampHeader: 'x-ref-timestamp',
    signedPayload: (body, ts) => Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), body]),
  },
  toleranceSec: 300,
```

`WebhookGate` checks, in order: platform, body size, signature header and
format, timestamp window, secret, the HMAC over the raw body in constant time,
then `parse` and the event schema. Every failure returns the same `rejected`
result; the reason is logged as a check name only. `parse` is called only for
bodies whose signature already verified, and must work on the raw bytes you
were given.

Duplicates are detected by the framework: the key is the SHA-256 of the signed
raw body (per connection for connection-scoped secrets), recorded under queue
`webhook:<platform>`. Nothing outside the signed body can influence it, and
there is no delivery id in the contract; do not rely on one. A platform with
no signed timestamp (Meta, for example) gets replay protection only from that
record.

The platform's verification handshake (Meta's `hub.challenge`, for example)
is not part of the gate. It belongs to the receiver route; the Facebook route
in `apps/api` is the example.

## Lifecycle hooks

A connector that must do platform-side work when a connection is made or
removed (Facebook subscribes the Page to the app's webhook) declares
`lifecycle: ConnectorLifecycle`.

- `onConnected(ctx)` runs after every connect and reconnect, from a job so a
  slow platform cannot fail the user's request. It must be idempotent.
- `onDisconnected(ctx)` runs after the connection has been revoked locally. It
  is idempotent and best-effort: when the token no longer works the framework
  still deletes the stored credentials and finishes.
- Both receive an ordinary `CallContext`, so the same budget, `SafeHttp` and
  error mapping apply. Do not read or write the database from a hook.

## Webhook routing for app-secret platforms

With `secretSource: 'app'` the platform signs every delivery with one app-wide
secret and one delivery can carry events for many accounts, in many
workspaces. The gate therefore verifies the signature before it knows who the
events are for, and routing happens after:

- `parse` returns `InboundEvent`s, each with its own `externalAccountId`. Drop
  events whose ids do not have the platform's expected shape in `parse`; they
  can be attacker-influenced even when the signature is valid.
- The receiver passes the verified delivery to a router, which looks up the
  one live connection for each account with `findLiveByAccount` and enqueues
  work for that connection's own scope. Events for an account with no live
  connection are dropped and counted. A `reconnect_required` connection still
  receives its events: the work is held and replayed once it reconnects.
- Make the receiver respond quickly and do the platform fetches in jobs. A
  failing router must fail the request so the platform redelivers; the gate
  leaves the delivery unprocessed in that case.
- The verification handshake (Meta's `hub.challenge`) is not part of the gate.
  It belongs to the receiver route, together with its verify token.

`routeWebhookDelivery` in `@feedbouncer/comments` is the router the Facebook
route uses.

## Sharing a webhook subscription host (field-merging)

Some platforms keep one subscription per app and per host object, with a
single list of subscribed fields that each write replaces. When two connectors
use the same host (Facebook and Instagram both subscribe the same Facebook
Page), they must not overwrite each other's fields.

- Never write a fixed list. Read the current list, add or remove only your
  own fields, and write back the union.
- Delete the subscription only when no field is left.
- Make both directions idempotent, so a repeated lifecycle job is harmless.
- `subscribePageFields` and `unsubscribePageFields` in
  `@feedbouncer/connector-facebook` do this for Meta Pages. The Facebook
  connector owns `feed` and the Instagram connector owns `comments`.

## Rate limits

The budget is per connected account: the key is the organization, brand and
connection together, not the platform app. Your `RateLimitPolicy` sets
`points` per `durationSec`. Reads (`bulk`) can use at most
`points - urgentReservePoints` of a window; actions (`urgent`) can use all of
it, so a long backfill cannot starve a moderation action.

When the budget is exhausted the call fails fast with
`rate_limited` / `budget_exhausted` and a `retryAfterMs`; work is deferred,
not dropped. If the budget store is down the call fails closed as `transient`.

Map platform throttling yourself. Parse `Retry-After` with `parseRetryAfter`
and throw `rate_limited` with it; the runtime then blocks the account's budget
for that long and falls back to `defaultRetryAfterMs` when no hint is given.

```ts from=reference/connector.ts
if (err.status === 429)
  throw new ConnectorError('rate_limited', 'platform_throttled', {
    retryAfterMs: (err.retryAfterSec ?? 60) * 1000,
  });
```

App-wide quotas, such as YouTube's daily project quota, are not covered:
the budget does not see calls made for other accounts of the same app.

## Errors

Throw `ConnectorError(kind, code, opts)`. There are six kinds, and only these:

| Kind           | Meaning                        | Typical HTTP                  | Framework reaction                                                                                                                                                                                              | Job queue outcome                                                                                                                                                         |
| -------------- | ------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_expired` | Credential rejected or revoked | 401, `invalid_grant`          | A rejected access token gets one refresh-and-retry, then reports `reauthorize: true`; a connection already known `revoked` or `reconnect_required` skips the retry and reports its own `reauthorize` right away | Dead-lettered as `needs_reconnection` if `reauthorize` is true, `non_retryable` if false (a revoked connection's `reauthorize: false` means reconnecting wouldn't fix it) |
| `rate_limited` | Throttled                      | 429, platform quota errors    | Budget blocked for `retryAfterMs`, caller defers                                                                                                                                                                | Deferred by at least `retryAfterMs`, no attempt used                                                                                                                      |
| `not_found`    | Target is gone                 | 404, 410                      | Read returns `null`, action returns `not_found`                                                                                                                                                                 | Dead-lettered `non_retryable`; `resolved` on a replay                                                                                                                     |
| `unsupported`  | Platform cannot do this        | 501, feature not available    | `unsupported` result                                                                                                                                                                                            | Dead-lettered `non_retryable`                                                                                                                                             |
| `transient`    | Retry may succeed              | 5xx, network, timeout         | Surfaced as retryable                                                                                                                                                                                           | Retried with backoff, then `retries_exhausted`                                                                                                                            |
| `permanent`    | Retrying will not help         | other 4xx, malformed response | Surfaced as failed                                                                                                                                                                                              | Dead-lettered `non_retryable`                                                                                                                                             |

How the job queue treats these is described in
[docs/operations/job-queue.md](../operations/job-queue.md#error-classes); to write a job
that calls a connector, see [docs/jobs/defining-a-job.md](../jobs/defining-a-job.md).

Rules:

- `code` is lowercase `snake_case` and matches `^[a-z][a-z0-9_]{0,62}$`.
  Anything else is replaced by `unspecified`.
- The message is built from the kind and code only. Never put a response body,
  URL, header or token into an error, and never `catch` and re-wrap a foreign
  error with its message.
- If you throw something that is not a `ConnectorError`, the framework
  replaces it with `permanent` / `connector_failure` and logs only
  `err.name`. Map errors instead of relying on that.
- A failure of the framework's own storage (connection directory, vault,
  refresh lock, budget store) is never blamed on your connector: the call
  reports `transient` / `storage_unavailable`, so the caller retries.
- The connection status is checked before every call. `revoked` is terminal:
  `auth_expired` / `connection_revoked` with `reauthorize: false`.
  `reconnect_required` reports `auth_expired` / `reauthorization_required`
  with `reauthorize: true`. `error` and `paused` report `permanent` /
  `connection_inactive`.

```ts from=reference/connector.ts
if (err.status === 401) throw new ConnectorError('auth_expired', 'token_rejected');
if (err.status === 400 && err.error === 'invalid_grant')
  throw new ConnectorError('auth_expired', 'invalid_grant');
if (err.status === 404) throw new ConnectorError('not_found', 'not_found');
```

## Security checklist

- No `process.env` in connector code. Configuration comes from the factory.
- Never log, interpolate or return `ctx.accessToken`, a refresh token, an
  authorization code, a PKCE verifier, an OAuth state, a webhook secret or a
  signature. Reveal a `Secret` only at the call that sends it.
- Make every request through `ctx.http` (`SafeHttp`) with `ctx.signal`. No
  global `fetch`.
- List exact hostnames in `apiHosts` and `authorizationHosts`. No wildcards,
  no ports.
- Do not re-validate what the schemas already enforce (id length, https URLs,
  body size); return normalized values and let the boundary check them.
- Put nothing from a response into an error message.
- Do not rely on delivery ids or unsigned headers for webhook correctness.

## Running the conformance suite

The suite lives in `@feedbouncer/connectors/testing`. It needs a
`PlatformDriver`: an async handle on your platform double (recorded HTTP
fixtures or a fake server) that can create accounts, run the consent step,
seed content, expire and revoke tokens, throttle, count calls, sign a webhook
delivery, and list every secret it ever issued. A harness bundles the
connector, the driver and a `Stack` of framework services over ports.

The reference connector's harness is the template (`createInMemoryHarness`
in `src/testing/runtime.ts`, using `createMemoryStack` and `platformDriver`).
Your test file then reduces to:

```ts from=reference.conformance.test.ts
import { createInMemoryHarness, runConnectorConformance } from './testing/index.js';
runConnectorConformance('reference push (webhooks, rotating tokens, all actions)', () =>
  createInMemoryHarness('push'),
);
```

For a real connector, put it in `src/<platform>.conformance.test.ts` and call
`runConnectorConformance('my-platform', makeHarness)`:

```ts
import { runConnectorConformance, type ConformanceHarness } from '@feedbouncer/connectors/testing';

async function makeHarness(): Promise<ConformanceHarness> {
  // connector + PlatformDriver + assembleStack(...)
}

runConnectorConformance('my-platform', makeHarness);
```

The suite covers OAuth, refresh and rotation, reads, actions, budgets, webhooks and secret
hygiene.

The generic suite assumes one account per authorization and refreshable
tokens. A connector with `accountSelection: 'multiple'`, tokens that do not
refresh, or replies and lifecycle hooks cannot use it as is. The Facebook
connector instead runs its own contract suite
(`packages/connector-facebook/src/contract.test.ts`) against an in-memory
Graph double, covering selection, non-refreshable tokens, replies, lifecycle
and webhooks. Use it as the pattern for such platforms.

A port set of your own (a custom adapter set) must supply `faults`, whose
`failNextAccessWrite()` makes the next access-token write throw once, and
`memberships.grant`. Without them the rotation-safety and impostor scenarios
cannot run. Pass `{ realTime: true }` when time lives outside the process
(Redis, Postgres); the Postgres and Redis run in
`src/pg/conformance.integration.test.ts` shows the setup.
