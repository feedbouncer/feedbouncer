# Provisioning API runbook

The platform provisioning API (`/provisioning/v1`) is off unless `PROVISIONING_CREDENTIAL_SHA256` is set on the API service. Request and response shapes are in the [Provisioning API guide](../../apps/docs/docs/concepts/provisioning-api.md).

## Enable

```
pnpm --filter @feedbouncer/api provisioning:credential
```

Hand the printed `fbp_…` token to the external system. Set the printed digest as `PROVISIONING_CREDENTIAL_SHA256` and restart the API. A malformed value stops the API at startup.

## Rotate without downtime

1. Generate a new credential.
2. Set `PROVISIONING_CREDENTIAL_SHA256=<old>,<new>` and restart.
3. Switch the external system to the new token.
4. Confirm the old fingerprint (first 12 characters of the old digest) has no recent calls:

   ```sql
   SELECT credential_fingerprint, max(created_at) AS last_used
   FROM provisioning_audit_event
   GROUP BY 1;
   ```

5. Set `PROVISIONING_CREDENTIAL_SHA256=<new>` and restart.

To switch the API off, unset the variable and restart.

## Log events

- `provisioning.auth_failed`: a rejected credential. Logged with the `reason` and the route, never the token. Not audited, so unauthenticated callers can't flood the table.
- `provisioning.setup_email_failed`: the user was created but the setup email was not sent. The user can use "Forgot password".
- `provisioning.audit_failed`: a failure record could not be written.
- `user.access_denied_inactive`: a deactivated user was refused (`via` says where).
- `user.status_unrecognized`: a user row has a status the code doesn't know. It is treated as inactive.

## Audit queries

Calls on one account:

```sql
SELECT created_at, action, outcome, credential_fingerprint, details
FROM provisioning_audit_event
WHERE target_type = $1 AND target_id = $2
ORDER BY created_at DESC;
```

Status changes in the last 7 days:

```sql
SELECT created_at, action, target_id, details
FROM provisioning_audit_event
WHERE action LIKE '%.set_status' AND outcome = 'changed'
  AND created_at > now() - interval '7 days';
```
