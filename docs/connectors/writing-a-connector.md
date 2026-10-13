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

No API routes ship with the framework yet. `OAuthFlow` checks brand membership
and the `connection.manage` capability itself, so a route added later cannot
skip it.

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
- There is no `reply` action yet.

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
is not part of the gate. It belongs to the receiver route, which ships with
the first real connector.

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

A port set of your own (a custom adapter set) must supply `faults`, whose
`failNextAccessWrite()` makes the next access-token write throw once, and
`memberships.grant`. Without them the rotation-safety and impostor scenarios
cannot run. Pass `{ realTime: true }` when time lives outside the process
(Redis, Postgres); the Postgres and Redis run in
`src/pg/conformance.integration.test.ts` shows the setup.
