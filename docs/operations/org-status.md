# Organization status

Every organization is `active` or `suspended`. New and existing organizations are `active`.

## Changing the status

```
pnpm ops org-status show <orgId>
pnpm ops org-status set <orgId> <active|suspended> --actor <userId> --reason <abuse|non_payment|customer_request|other>
```

`set` changes the status and writes an `organization.suspended` or `organization.reactivated` audit event in the same transaction. Setting the status an organization already has does nothing and writes no event. Exit codes: `2` for bad input, `1` for `org_not_found` or `actor_not_found`.

The change applies from the next request. Nobody has to sign out and no key has to be rotated. Reactivating restores access, and revoked keys stay revoked.

## What suspension does

- Members get `403 organization_suspended` on every organization route. Non-members still get `404`.
- API keys of the organization get `403 organization_suspended` on every `/v1` route. Unknown, wrong-secret and revoked keys still get `401`, so nothing about the organization is revealed.
- API keys can't be created. Accepting an invitation and changing report subscriptions are refused. Connecting a platform through OAuth is rejected.
- The user's other organizations keep working. `/me` and `/orgs` still list the suspended organization, with its status.
- A status that is missing or not recognized is treated as suspended.

## What suspension does not do

Background work keeps running for a suspended organization: scheduled moderation, polling, webhook deliveries, weekly reports and alerts. For a hard stop, also disconnect its platform connections.

## Support

Denied requests are logged, not audited, so a retrying integration can't flood the audit table:

- `org.access_denied_suspended`: `orgId`, `via` (`session` or `api_key`), `route`, and `userId` or `apiKeyId`.
- `org.status_unrecognized`: `orgId`, `via`. The stored value is never logged.

Status history:

```sql
SELECT action, created_at, actor_user_id, details
FROM audit_event
WHERE subject_id = $1
  AND action IN ('organization.suspended', 'organization.reactivated')
ORDER BY sequence DESC;
```
