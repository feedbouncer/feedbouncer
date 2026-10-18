# Private beta operator runbook

For the Beta operator. Partners read [the partner guide](partner-guide.md).

## Configuration

| Variable                      | Meaning                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SIGNUP_ALLOWED_EMAILS`       | Comma-separated emails (at most 200) allowed to sign up. Unset or empty and anyone can. Others get a private beta email.                         |
| `BETA_SUPPORT_EMAIL`          | The contact address shown in that email and in the in-app beta notice.                                                                           |
| `BETA_FEEDBACK_URL`           | An https link to your feedback form. With the support email it shows the beta notice in the web app.                                             |
| `INSTAGRAM_CONNECTOR_ENABLED` | `true` turns on the Instagram connector. Set it on the API and the worker. See [instagram.md](../connectors/instagram.md#environment-variables). |

## Invite flow

1. Add the partner's email to `SIGNUP_ALLOWED_EMAILS` and redeploy.
2. In the Meta dashboard, add the partner's Facebook account as a **Tester**.
3. The partner accepts at developers.facebook.com/requests.
4. Confirm that the app's Roles page shows them as accepted.
5. The partner signs up with the invited email and connects their Page. If
   connecting ends with `provider_error`, step 3 was usually missed.

## Daily check

Run `pnpm ops beta-status` (add `--json` for scripts). It prints one row per
connection: health, last success, comments and evaluated counts for the last 24
hours, unevaluated comments, failed imports and queued jobs. Backfilled
comments are not counted.

It exits with code 2 when any connection needs attention: an unevaluated
comment older than 10 minutes, a failed import, or a connection that needs
reconnecting. On exit code 2:

1. Rows with `needs_reconnection`: the owners were emailed once. Ask the partner
   to reconnect from the Connections page.
2. Rows with `unevaluated` above 0: check the worker logs, then the DLQ below.
3. Rows with `failedImports`: see [backfill.md](../connectors/backfill.md).
4. Health reasons are explained in [observability.md](../operations/observability.md).

## Dead letter queue

```text
pnpm jobs dlq list --platform facebook --reason needs_reconnection
pnpm jobs dlq replay --platform facebook --reason needs_reconnection --dry-run
pnpm jobs dlq replay --id <job-id>
```

Reasons and the rest of the options are in
[job-queue.md](../operations/job-queue.md). Replay `needs_reconnection` jobs
only after the partner has reconnected. `list` hides payloads unless you pass
`--show-payload`; payloads may contain comment text.

## Weekly check-in

1. Collect [the feedback form](feedback-form.md) answers.
2. Review the Action log together: false positives first, then misses.
3. Review `pnpm ops beta-status` for the week, and the DLQ.
4. Review rule and classifier settings that the examples point at.
5. Record bugs and feature requests, and decisions, for [the summary](beta-summary.md).

## Offboarding

1. Follow [the data deletion procedure](../operations/data-deletion.md).
2. Remove the partner's email from `SIGNUP_ALLOWED_EMAILS` and remove their
   Tester role in the Meta dashboard.
3. Log the request in the Record table of that document.
