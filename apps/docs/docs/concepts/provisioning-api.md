---
title: Provisioning API
description: Create organizations and users and switch them on or off from a system you run, with a service credential that is separate from user sessions and API keys.
status: stable
---

The provisioning API lets an external system, such as a billing or customer-management platform, create organizations and users and mark them active or inactive. It lives under `/provisioning/v1`, has its own credential, and never accepts sessions or user API keys. The reverse is also true: the provisioning credential is refused on every `/v1` and user route.

## Enable

1. Generate a credential: `pnpm --filter @feedbouncer/api provisioning:credential`. It prints the token (`fbp_…`) once, and the digest.
2. Give the token to the external system. Keep it in its secret store.
3. Set `PROVISIONING_CREDENTIAL_SHA256` to the digest on the API service only, and restart the API.

The server stores only the digest. If the variable is unset, the API is off and every `/provisioning/v1` route answers `404`, exactly like a route that does not exist. A malformed value stops the API from starting.

## Authenticate

Send `Authorization: Bearer fbp_…` on every request. A missing, malformed or wrong token gets `401 unauthenticated`. Ten failed attempts from one address in 15 minutes get `429 rate_limited` with a `Retry-After` header.

## Rotate

You can rotate without downtime, because the variable holds one or two digests.

1. Generate a new credential.
2. Set `PROVISIONING_CREDENTIAL_SHA256=<old>,<new>` and restart.
3. Switch the external system to the new token.
4. Check that the old one is no longer used (see [Audit](#audit): the `credential_fingerprint` is the first 12 characters of the digest).
5. Set `PROVISIONING_CREDENTIAL_SHA256=<new>` and restart.

## Endpoints

All bodies are JSON. Unknown fields are rejected.

| Method and path                                  | Purpose                           |
| ------------------------------------------------ | --------------------------------- |
| `POST /provisioning/v1/organizations`            | Create an organization            |
| `GET /provisioning/v1/organizations/{id}`        | Read an organization              |
| `PUT /provisioning/v1/organizations/{id}/status` | Set an organization's status      |
| `POST /provisioning/v1/organizations/{id}/users` | Create a user in an organization  |
| `GET /provisioning/v1/users/{id}`                | Read a user and their memberships |
| `PUT /provisioning/v1/users/{id}/status`         | Set a user's status               |

### Create an organization

Request: `{ "externalRef": "acct-42", "name": "Acme" }`. Response `201` (or `200` on a replay):

```json
{
  "organization": {
    "id": "…",
    "externalRef": "acct-42",
    "name": "Acme",
    "status": "active",
    "createdAt": "2026-11-06T10:00:00.000Z"
  },
  "replayed": false
}
```

### Create a user

Request:

```json
{
  "externalRef": "user-7",
  "email": "ana@example.com",
  "name": "Ana",
  "role": "owner",
  "allowInactiveOrganization": false,
  "sendSetupEmail": true
}
```

`role` is `owner`, `admin` or `member`. The last two fields are optional. Response `201` (or `200` on a replay):

```json
{
  "user": {
    "id": "…",
    "externalRef": "user-7",
    "email": "ana@example.com",
    "name": "Ana",
    "status": "active",
    "memberships": [{ "organizationId": "…", "role": "owner", "organizationStatus": "active" }],
    "createdAt": "2026-11-06T10:00:00.000Z"
  },
  "replayed": false,
  "setupEmail": "sent"
}
```

`setupEmail` is `sent`, `skipped` (replay, or `sendSetupEmail: false`) or `failed`. A failed email does not undo the create.

### Read

`GET` returns `{ "organization": { … } }` or `{ "user": { … } }` in the shapes above.

### Set status

Request: `{ "status": "inactive", "reason": "non_payment" }`. `status` is `active` or `inactive`. `reason` is optional: `abuse`, `non_payment`, `customer_request` or `other`. The response is the record plus `changed`, which is `false` when it already had that status.

### Errors

| Status and code             | When                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `401 unauthenticated`       | The credential is missing or wrong.                                                  |
| `400 invalid_request`       | A field is invalid. `issues` names each field and never repeats the submitted value. |
| `404 not_found`             | The organization or user does not exist, or the id is not a UUID.                    |
| `409 external_ref_mismatch` | The `externalRef` exists with different values.                                      |
| `409 email_in_use`          | Another account already has this email. That account is left untouched.              |
| `409 organization_inactive` | The organization is inactive and `allowInactiveOrganization` is not `true`.          |
| `429 rate_limited`          | Too many failed authentications from this address.                                   |

## Idempotency

Both create calls require an `externalRef`: your own id for the account, up to 200 characters. Repeating a call with the same `externalRef` and the same values returns the original record with `200` and `replayed: true`. Reusing it with different values returns `409 external_ref_mismatch`. Concurrent calls with the same reference are serialized, so they never create duplicates.

What is compared: for an organization, the `name`. For a user, the `email`, `name`, and the `role` in the organization named in the path. `allowInactiveOrganization` and `sendSetupEmail` are not compared.

## Statuses

Both organizations and users are `active` or `inactive`. Everything starts `active`. An inactive organization is the same as a suspended one in <RepoLink path="docs/operations/org-status.md">organization status</RepoLink>.

- **Inactive organization:** its members get `403 organization_suspended`, and its API keys are refused. Other organizations of the same users keep working.
- **Inactive user:** cannot sign in (they see the usual "invalid email or password"), their open sessions end, and their API keys get `403 key_owner_inactive`. Password change and account deletion are refused.

Reactivating restores access from the next request. No data is lost, but users sign in again.

## Provisioned users

The API never sets or returns a password. A new user has a verified email and no password. By default they get a "set up your account" email with a link, valid for 1 hour, where they choose a password. If it expires, they use **Forgot password** on the sign-in page.

## Audit

Every authenticated call is recorded in `provisioning_audit_event`, which cannot be changed or deleted: `created_at`, `credential_fingerprint`, `action`, `target_type`, `target_id`, `outcome` (`created`, `replayed`, `read`, `changed`, `unchanged`, `not_found`, `conflict`, `invalid`, `failed`) and `details`. Organization changes also appear in the organization's audit history. Secrets are never stored.

```sql
SELECT created_at, action, outcome, target_id, credential_fingerprint
FROM provisioning_audit_event
ORDER BY created_at DESC
LIMIT 50;
```
