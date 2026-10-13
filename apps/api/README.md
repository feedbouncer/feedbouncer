# @feedbouncer/api

NestJS (Fastify) API: accounts, organizations, brands, members and invitations. Browsers never call it directly: the web app proxies `/api/auth/*` and `/api/v1/*` to it (see `apps/web/next.config.ts`), so cookies and origin checks are same-origin.

## Configuration

Read and validated at startup by `src/env.ts`; the process refuses to start on a missing or invalid value.

| Variable                                                              | Required        | Purpose                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                        | yes             | Postgres connection URL                                                                                                                                                                                                        |
| `REDIS_URL`                                                           | yes             | Redis URL (rate limits)                                                                                                                                                                                                        |
| `AUTH_SECRET`                                                         | yes             | Signs session cookies and tokens; at least 32 characters. Generate with `openssl rand -base64 48`. Never log or commit a real one.                                                                                             |
| `PUBLIC_WEB_URL`                                                      | yes             | The exact origin users type, with no path (for example `https://app.example.com`). It is the only origin allowed on state-changing requests and the base of every emailed link.                                                |
| `SMTP_URL`                                                            | yes             | `smtp://` or `smtps://` URL of the mail server (Mailpit in the dev stack)                                                                                                                                                      |
| `MAIL_FROM`                                                           | no              | From header of outgoing mail. Default `FeedBouncer <no-reply@localhost>`                                                                                                                                                       |
| `TRUST_PROXY_HOPS`                                                    | no              | Number of reverse proxies in front of the API whose `X-Forwarded-For` is trusted for the client IP (0-5, default 0). Per-IP rate limits depend on it: set it to the real hop count, never higher. See [Client IP](#client-ip). |
| `PORT`                                                                | no              | Listen port, default 3001                                                                                                                                                                                                      |
| `LOG_LEVEL`                                                           | no              | Default `info`                                                                                                                                                                                                                 |
| `FB_ENV`                                                              | no              | `development`, `test` or `production`. Default `production`: documented example values (placeholders) are refused. In `development` they only log a warning.                                                                   |
| `FB_ENCRYPTION_KEYS`                                                  | yes             | Keys that encrypt stored platform tokens: `<key-id>:<base64 of 32 random bytes>`, comma-separated. Generate one with `pnpm secrets keygen`. Never log or commit a real one.                                                    |
| `FB_ENCRYPTION_ACTIVE_KEY_ID`                                         | yes             | The key id used for new encryption. It must be one of the ids in `FB_ENCRYPTION_KEYS`.                                                                                                                                         |
| `FACEBOOK_APP_ID`                                                     | no              | Numeric Meta app id. Unset means the Facebook connector, its webhook route and its jobs are off. Setup: [docs/connectors/facebook.md](../../docs/connectors/facebook.md).                                                      |
| `FACEBOOK_APP_SECRET`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN`                | with the app id | The Meta app secret (at least 16 characters) and the webhook verify token (at least 20). Both accept `_FILE`.                                                                                                                  |
| `FACEBOOK_GRAPH_API_VERSION`                                          | no              | Graph API version, `vNN.0`. Default `v26.0`.                                                                                                                                                                                   |
| `METRICS_PORT`, `METRICS_HOST`, `OTEL_TRACES_EXPORTER`, `CONNECTOR_*` | no              | Telemetry and connector-health thresholds. The API serves `/metrics` on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`, `0` disables). Tracing is off unless `OTEL_TRACES_EXPORTER=otlp`.                               |

`DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`, `SMTP_URL`, `FB_ENCRYPTION_KEYS`, `FACEBOOK_APP_SECRET` and `FACEBOOK_WEBHOOK_VERIFY_TOKEN` can instead be read from a mounted file by setting `<NAME>_FILE` to its absolute path (not both). Key rotation, backup and recovery: [docs/operations/secrets.md](../../docs/operations/secrets.md).

## Roles and tenancy

Roles are per organization: `owner`, `admin`, `member`. A user can belong to several organizations with a different role in each. Capabilities live in `packages/authz`.

| Capability                                  | owner | admin                                    | member |
| ------------------------------------------- | ----- | ---------------------------------------- | ------ |
| Read organization, brands, members          | yes   | yes                                      | yes    |
| Create, rename and archive brands           | yes   | yes                                      | no     |
| Rename the organization                     | yes   | yes                                      | no     |
| Invite, list and revoke invitations         | yes   | yes                                      | no     |
| Change a role / remove a member             | yes   | yes (never an owner, never grants owner) | no     |
| Transfer ownership, delete the organization | yes   | no                                       | no     |
| Leave the organization                      | yes   | yes                                      | yes    |

An organization always keeps at least one owner (`last_owner`), and a sole owner cannot delete their account (`sole_owner`). Both are also enforced by database triggers.

Organization-scoped routes live under `/api/v1/orgs/:orgId/...`. A user who is not a member gets the same `404` as for an organization that does not exist. The web app mirrors this as `/orgs`, `/orgs/:orgId` and `/orgs/:orgId/members`; other pages are `/sign-up`, `/login`, `/verified`, `/forgot-password`, `/reset-password`, `/invite?token=...` and `/account`.

## Routes

All bodies are JSON. State-changing requests must carry the web origin (`Origin`, or `Sec-Fetch-Site: same-origin`). Authenticated routes use the session cookie.

### Account (no session unless noted)

| Method and path                          | Notes                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/auth/sign-up`              | `{ email, password, name }` -> `202`. Same response for new and existing addresses.                                                                                            |
| `POST /api/auth/sign-in/email`           | `{ email, password }` -> `200 { status: "ok" }` and a session cookie                                                                                                           |
| `POST /api/auth/sign-out`                | `200`                                                                                                                                                                          |
| `GET /api/auth/verify-email?token=`      | Redirects to `/verified` (or `/verified?error=invalid_token`)                                                                                                                  |
| `POST /api/auth/send-verification-email` | `{ email }` -> always `200`                                                                                                                                                    |
| `POST /api/auth/request-password-reset`  | `{ email }` -> always `200`                                                                                                                                                    |
| `POST /api/auth/reset-password`          | `{ token, newPassword }`; revokes all sessions                                                                                                                                 |
| `POST /api/auth/change-password`         | session; `{ currentPassword, newPassword }`; revokes other sessions                                                                                                            |
| `POST /api/auth/delete-user`             | session; `{ password }`; `409 sole_owner` if the user is the only owner of an organization; `503 temporarily_unavailable` on a database lock conflict (nothing deleted, retry) |
| `GET /api/v1/me`                         | session; `{ user, memberships }`                                                                                                                                               |

Only these `/api/auth/*` paths are reachable; everything else under it is `404`.

### Organizations, brands, members, invitations (session)

| Method and path                                              | Capability                       | Success                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/orgs`                                           | any session                      | `200 { organizations }`                                                                                                         |
| `POST /api/v1/orgs`                                          | verified email                   | `201 { organization, brand }` (`{ name, brandName? }`)                                                                          |
| `GET /api/v1/orgs/:orgId`                                    | `org.read`                       | `200 { organization, role }`                                                                                                    |
| `PATCH /api/v1/orgs/:orgId`                                  | `org.update`                     | `200 { organization }`                                                                                                          |
| `DELETE /api/v1/orgs/:orgId`                                 | `org.delete`                     | `204` (`{ confirmName }`)                                                                                                       |
| `POST /api/v1/orgs/:orgId/transfer-ownership`                | `org.transfer_ownership`         | `200` (`{ userId, newRoleForSelf }`)                                                                                            |
| `GET /api/v1/orgs/:orgId/brands`                             | `brand.read`                     | `200 { brands }` (`?includeArchived=true`)                                                                                      |
| `POST /api/v1/orgs/:orgId/brands`                            | `brand.write`                    | `201 { brand }`                                                                                                                 |
| `GET /api/v1/orgs/:orgId/brands/:brandId`                    | `brand.read`                     | `200 { brand }`                                                                                                                 |
| `PATCH /api/v1/orgs/:orgId/brands/:brandId`                  | `brand.write`                    | `200 { brand }`                                                                                                                 |
| `POST /api/v1/orgs/:orgId/brands/:brandId/archive`           | `brand.write`                    | `200 { brand }`                                                                                                                 |
| `GET /api/v1/orgs/:orgId/brands/:brandId/connections/health` | `connection.read` (owner, admin) | `200 { connections }`: per-connection health state, bounded reason, error code only; `404` for a brand outside the organization |
| `GET /api/v1/orgs/:orgId/members`                            | `member.read`                    | `200 { members }`                                                                                                               |
| `PATCH /api/v1/orgs/:orgId/members/:userId`                  | `member.change_role`             | `200 { member }` (`{ role }`)                                                                                                   |
| `DELETE /api/v1/orgs/:orgId/members/:userId`                 | any member (self = leave)        | `204`                                                                                                                           |
| `GET /api/v1/orgs/:orgId/invitations`                        | `invitation.read`                | `200 { invitations }` (pending only)                                                                                            |
| `POST /api/v1/orgs/:orgId/invitations`                       | `member.invite`                  | `201` created or renewed, `200` already a member (`{ email, role }`)                                                            |
| `POST /api/v1/orgs/:orgId/invitations/:id/revoke`            | `member.invite`                  | `200`                                                                                                                           |
| `POST /api/v1/invitations/lookup`                            | any session                      | `200` (`{ token }`)                                                                                                             |
| `POST /api/v1/invitations/accept`                            | verified, matching email         | `200` (`{ token }`)                                                                                                             |

Invitations expire after 7 days; inviting an address that already has a pending invitation renews it. Creating or renewing an invitation answers `201` with `emailSent: false` when the address's or the client's email budget (see [Rate limits](#rate-limits)) is spent: the invitation is saved but no email goes out, and a renewal then keeps the token of the link that was already emailed. Accepting an invitation as someone who is already a member of the organization keeps their current role (the invitation's role is not applied) and marks the invitation accepted; the audit event `invitation.accepted` records `joined: false`. Sessions last 7 days (sliding), password reset links 1 hour, email confirmation links 24 hours.

### Health

`GET /livez` and `GET /healthz` (Postgres and Redis); unauthenticated and outside `/api/v1`.

## Errors

Every error has one shape, and the codes are stable:

```json
{ "error": { "code": "forbidden", "message": "You do not have permission to do this." } }
```

| Status  | Codes                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 400     | `invalid_request`, `invalid_email`, `invalid_or_expired_token`, `confirmation_mismatch`                                       |
| 401     | `unauthenticated`, `invalid_credentials`                                                                                      |
| 403     | `forbidden`, `invalid_origin`, `email_not_verified`, `cannot_act_on_owner`, `cannot_grant_owner`, `invitation_email_mismatch` |
| 404     | `not_found` (unknown resource, or an organization you are not a member of)                                                    |
| 409     | `last_owner`, `sole_owner`, `brand_name_taken`, `brand_archived`, `invitation_not_pending`                                    |
| 422     | `password_too_short`, `password_too_long`, `weak_password`                                                                    |
| 429     | `rate_limited`                                                                                                                |
| 500/503 | `internal_error`, `temporarily_unavailable` (Redis unreachable: rate-limited endpoints fail closed)                           |

## Security notes

- Passwords are 12-128 characters and must score at least 3 on zxcvbn. They are stored as salted hashes only.
- Bearer secrets are stored as SHA-256 digests: session tokens in `auth_session.token`, and verification and reset identifiers in `auth_verification.identifier`. The raw value exists only in the cookie or the emailed link. See the Security notes in [packages/db/README.md](../../packages/db/README.md).
- Login, reset and sign-up responses do not reveal whether an address has an account.
- Mailpit (the dev mail inbox) has an unauthenticated web UI. It is for development only and the compose file binds it to `127.0.0.1` by default; never expose it.

### Rate limits

Redis-backed, per 15-minute or 1-hour window:

| Limit                        | Budget                                                 |
| ---------------------------- | ------------------------------------------------------ |
| Login attempts per account   | 5 per 15 minutes, then blocked for 15 minutes          |
| Login attempts per client IP | 20 per 15 minutes, then blocked for 15 minutes         |
| Emails per address           | 3 per hour (verification, reset, sign-up, invitations) |
| Emails per client IP         | 20 per hour                                            |

Changing a password or deleting an account counts as a login attempt, once the request body is valid: a request refused for its body (a missing current password, or a new password that is too short or too weak) does not. A successful login clears the account counter. The trade-off: anyone who knows an address can lock that account out of password login for 15 minutes by failing five times; this is accepted over allowing unlimited guessing.

#### Client IP

The per-IP limits (and `auth_session.ip_address`) use the client address Fastify derives with `TRUST_PROXY_HOPS`: the TCP peer, or, when that peer is an internal address within the trusted hop count, the last `X-Forwarded-For` entry. A wrong value either shares one budget across all users (too low) or lets clients choose their own address (too high, or a proxy that passes the client's header through).

Browsers reach the API only through the web app, which is the one trusted hop (`TRUST_PROXY_HOPS=1` in `compose.yaml`). The web app forwards `/api/auth/*` and `/api/v1/*` with route handlers, not Next.js rewrites (a rewrite neither adds `X-Forwarded-For` nor drops the client's own): its `proxy.ts` deletes every client-supplied `X-Forwarded-*`, `Forwarded` and `X-Real-IP` header, Next then sets `X-Forwarded-For` to the TCP peer it accepted the connection from, and only that single address is sent to the API (see `apps/web/src/lib/api-proxy.ts`). `pnpm stack:auth-smoke` checks that a client-supplied `X-Forwarded-For` is ignored.

Consequences:

- In the Compose stack, every browser on the host reaches the web container through Docker's port publishing, so they all share one address (the Docker gateway) and one per-IP budget. That is expected in development.
- If another reverse proxy or load balancer is put in front of the web app, the web app sees that proxy as the client: per-IP limits then apply to the proxy as a whole. Making them per user again needs the web tier to trust that proxy's `X-Forwarded-For`, which it does not do today.
- Requests that reach the API port directly (published on `127.0.0.1` in development) come from the Docker gateway, an internal address, so they could choose their own `X-Forwarded-For`. Never publish the API port to an untrusted network.

## Tests

```bash
pnpm --filter @feedbouncer/api test               # unit tests, no services needed
pnpm --filter @feedbouncer/api test:integration   # real Postgres and Redis
```

Integration tests need `DATABASE_URL` (a role that may create databases; see [packages/db/README.md](../../packages/db/README.md)) and `REDIS_URL`. With the dev stack, publish the data stores with `compose.expose-db.yaml` and use `REDIS_URL=redis://:<REDIS_PASSWORD>@127.0.0.1:6379/0`. Each test file works in its own scratch database.

The end-to-end check through the web origin is `pnpm stack:auth-smoke` (stack running, see the root README).

## Rules for new tenant routes

1. Put `@UseGuards(SessionGuard, OrgAccessGuard)` on the controller and `@RequireCapability('<capability>')` on every handler. A handler without a capability throws instead of serving.
2. Filter every query by `req.org.organizationId`; never trust an organization or brand id from the body or path on its own.
3. Membership and role mutations call `lockOrganization` (see `src/tenancy/org-lock.ts`) first and re-read the actor's role under the lock.
4. Add the route to `CASES` in `src/security/isolation-cases.ts`. The route inventory test fails when a `/api/v1` route is neither covered there nor listed as an account route.
