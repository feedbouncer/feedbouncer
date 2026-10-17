# Weekly email report

Every Monday morning, each workspace's owners and admins get an email that summarises the previous week: comments processed, comments hidden by category, the ads with the highest share of hidden comments, estimated time saved and, when more than one brand was active, a per-brand split. The same numbers are on the **Weekly report** page (`/orgs/<id>/reports`), which owners and admins can open for any of the last 52 complete weeks.

The email never contains comment text or author names. Logs carry ids, counts, codes and week keys only.

## Enabling it

Reports are off by default. Set `WEEKLY_REPORTS=on` on the **worker**:

| Variable         | Used by | Description                                                                                         |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `WEEKLY_REPORTS` | worker  | `on` or `off`, default `off`. Any other value stops startup.                                        |
| `SMTP_URL`       | worker  | Required when `WEEKLY_REPORTS=on`.                                                                  |
| `MAIL_FROM`      | worker  | Required when `WEEKLY_REPORTS=on`.                                                                  |
| `PUBLIC_WEB_URL` | worker  | Required when `WEEKLY_REPORTS=on`. Every link in the email (report, unsubscribe, settings) uses it. |

With `off`, the worker starts no report loops and logs `reports.disabled` once. The API always serves the Weekly report page and the subscription settings, with or without mail.

Each workspace has a timezone (organization page, **Workspace timezone**). Until someone sets it, reports use UTC.

## When a report is sent

The report for week `W` covers local Monday 00:00 to the next Monday 00:00 in the workspace's timezone. Daylight saving changes are handled, so a week can be 167 or 169 hours long.

- **Due:** the report is due at local Monday 08:00 after the week ends. The scheduler checks every minute and creates at most one report per workspace and week (`weekly_report` is unique on `(organization_id, week_start)`), even with several worker replicas.
- **Catch-up:** if the worker was down, a report is still created up to 24 hours after it was due. Later than that, the week is recorded as `missed` and no email is sent, so nobody gets a stale report days late.
- **Quiet week:** if no comment was processed, the week is recorded as `skipped_quiet` and no email is sent.
- **Recipients:** owners and admins with a verified email address who have not unsubscribed. This is checked when the report is created and again just before each send.

Recipients unsubscribe with the link in the email (the page asks them to press a button, so link scanners cannot unsubscribe anyone), with the one-click `List-Unsubscribe` header, or under **Account → Weekly report emails**.

## Numbers are a snapshot

The numbers are computed once, when the report is created, and stored in `weekly_report.payload`. The email and the Weekly report page show that snapshot, so they always agree, even if comments are hidden, unhidden or deleted later. For weeks without a stored snapshot (quiet, missed, or before reports were enabled), the page computes the numbers from current data as of the due time and says so.

## Inspecting reports

Reports, one row per workspace and week:

```sql
SELECT organization_id, week_start, timezone, status, computed_at
  FROM weekly_report
 ORDER BY week_start DESC, organization_id
 LIMIT 50;
```

`status` is `queued` (computed, emails created), `skipped_quiet` or `missed`.

Deliveries, one row per recipient of a `queued` report:

```sql
SELECT r.week_start, d.organization_id, d.user_id, d.state, d.attempts, d.last_error_code,
       d.next_attempt_at, d.sent_at
  FROM weekly_report_delivery d
  JOIN weekly_report r ON r.id = d.report_id
 WHERE r.week_start = '2026-10-12'
 ORDER BY d.organization_id, d.state;
```

`state` moves from `pending` to `sending` and then to `sent`, `retrying` (a temporary SMTP failure), `failed` or `cancelled`. To see what is stuck or failing across all weeks:

```sql
SELECT state, last_error_code, count(*)
  FROM weekly_report_delivery
 WHERE state <> 'sent'
 GROUP BY 1, 2
 ORDER BY 3 DESC;
```

## Codes

| Where                                | Code                | Meaning                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weekly_report.status`               | `missed`            | The worker was not running (or the scheduler fell behind) for more than 24 hours after the report was due. No email was sent. Logged as `reports.missed`.                                                                                                         |
| `weekly_report_delivery` (cancelled) | `not_recipient`     | At send time the user was no longer an owner or admin of the workspace, had no verified email, or had left it. Nothing was sent, so no data reached them.                                                                                                         |
| `weekly_report_delivery` (cancelled) | `unsubscribed`      | The user unsubscribed after the report was created.                                                                                                                                                                                                               |
| `weekly_report_delivery` (failed)    | `outcome_unknown`   | A send started but the worker stopped before recording the result (its lease expired). The SMTP server may or may not have accepted the message. It is never resent automatically, so a recipient never gets the same report twice. Check the SMTP server's logs. |
| `weekly_report_delivery` (failed)    | `retries_exhausted` | Temporary SMTP failures on every attempt.                                                                                                                                                                                                                         |

Other codes are SMTP results: `smtp_<code>` is the server's reply code (5xx fail at once, 4xx are retried at 30 s, 2 min, 10 min, 30 min and 2 h, as for alert emails, see [alerts.md](alerts.md)).
