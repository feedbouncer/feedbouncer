# Data retention

How long FeedBouncer keeps each kind of data, and how it deletes data when you
choose a shorter period. Deleting one person's data on request is a separate
job: see [subject-requests.md](subject-requests.md). Deleting a whole
organization is in [data-deletion.md](data-deletion.md).

## Categories

There are five categories. The names are fixed.

| Category      | What it covers                                                                                                                                   | Cutoff column                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `comments`    | Comments (with everything that cascades from them) and authors left with no comments                                                             | `comment.ingested_at`, `author.updated_at`  |
| `decisions`   | Decisions, rule evaluations, classifications, policy evaluations, action runs, finished action suggestions, moderation actions, resolved reviews | `created_at`; `completed_at`; `resolved_at` |
| `previews`    | Policy previews and their results                                                                                                                | `created_at`                                |
| `operational` | Finished job ledger rows, webhook events, alert events, API idempotency records                                                                  | `created_at`                                |
| `audit`       | Audit events, finished privacy requests, finished retention runs                                                                                 | `created_at`; `finished_at`                 |

Some rows are never purged by their category:

- A moderation action that has not completed (`completed_at` is empty).
- Job ledger rows that are not finished. Only `completed` and `resolved` rows
  go; queued, running and dead-lettered rows stay.
- A webhook event or alert event with a delivery still pending, sending or
  retrying, and a comment that one of those events refers to.
- A comment with a moderation action still being carried out.
- A privacy request whose export can still be downloaded.

Three built-in limits already exist and are not lengthened: policy previews
(7 days), webhook events (30 days) and idempotency records (1 day). The period
that applies is the shorter of the configured one and the built-in one.

## Configuring

Set these on the worker. Each value is a whole number of days from `1` to
`36500`, or the word `forever`.

| Variable                     | Category      |
| ---------------------------- | ------------- |
| `RETENTION_COMMENTS_DAYS`    | `comments`    |
| `RETENTION_DECISIONS_DAYS`   | `decisions`   |
| `RETENTION_PREVIEWS_DAYS`    | `previews`    |
| `RETENTION_OPERATIONAL_DAYS` | `operational` |
| `RETENTION_AUDIT_DAYS`       | `audit`       |

Unset means `forever`. **Upgrading to this release deletes nothing**: with no
period set, only the three built-in limits above keep pruning, as before.

An empty string, `0`, a negative number, a decimal, `1e3`, `+5`, a value with a
space and anything non-numeric are all rejected. The worker refuses to start
and exits non-zero with:

```
RETENTION_COMMENTS_DAYS must be a whole number of days from 1 to 36500, or "forever" (got "abc").
```

Tuning, also worker-only:

| Variable                           | Values     | Default | Meaning                                                    |
| ---------------------------------- | ---------- | ------- | ---------------------------------------------------------- |
| `RETENTION_PURGE_INTERVAL_MINUTES` | 5-1440     | 60      | Time between purge runs                                    |
| `RETENTION_BATCH_SIZE`             | 100-10000  | 1000    | Rows deleted per transaction                               |
| `RETENTION_CONFIRM_ABOVE`          | 0-10000000 | 10000   | A category with more eligible rows is held until confirmed |
| `RETENTION_MAX_RUN_MINUTES`        | 1-120      | 10      | A run stops after this long and continues next time        |

With the bundled `compose.yaml` these are passed from `.env`; empty values use
the defaults.

## Effective settings and warnings

```
pnpm ops retention status
```

prints the period in force per category, the warnings, the built-in limits
that are shorter than your setting, and the last run. The same data is served
to owners and admins at `GET /api/v1/orgs/:orgId/privacy/retention`. Both show
what the worker last published, so start the worker once after changing
settings. Warnings are not errors:

| Code                           | Meaning                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `audit_below_recommended`      | `RETENTION_AUDIT_DAYS` is under 365. Keep audit records for at least a year.                        |
| `decisions_capped_by_comments` | Decisions are kept longer than comments, but deleting a comment deletes its decisions with it.      |
| `builtin_shorter`              | A built-in limit (previews 7 days, webhook events 30, idempotency records 1) is shorter than yours. |

## Changing a period

A new value applies when the worker restarts. Lengthening deletes nothing.
Shortening makes older data eligible on the next run, which can delete a lot
at once, so:

1. Set the new value and restart the worker.
2. `pnpm ops retention preview` prints, per category, the days, the number of
   eligible rows, how many are skipped for the review queue, whether the
   category is confirmed and whether it `would_hold`. It deletes nothing.
3. If the eligible count is above `RETENTION_CONFIRM_ABOVE` and the setting has
   not been confirmed, the category is **held**: nothing is deleted, the run
   logs `retention.held` and writes a `retention.held` audit event per
   organization.
4. Confirm it: `pnpm ops retention confirm --category comments --days 30 --as <your-name>`.
   The days must equal the current setting; otherwise nothing is confirmed and
   the command exits 2. The confirmation is valid until the setting changes.

`pnpm ops retention run` runs one purge now and prints the result.

## Schedule and safety

- The worker purges every `RETENTION_PURGE_INTERVAL_MINUTES`, in batches of
  `RETENTION_BATCH_SIZE`. Each batch is its own transaction.
- A run stops after `RETENTION_MAX_RUN_MINUTES` and is recorded as `partial`.
  The next run continues; cutoffs are recomputed and deleted rows are simply
  gone. An interrupted run needs no cleanup.
- Only one purge runs at a time across all worker replicas. A second one logs
  `retention.skipped_locked` and returns.
- **Review-queue protection:** rows of a comment with an open review item or a
  pending action suggestion are never deleted by the `comments` and `decisions`
  categories. They are counted as `skippedPendingReview` and go on a later run
  once the item is resolved.
- Every run writes `retention.purged` audit events with counts per organization
  and category. They hold counts only.
- Whatever the settings, each run also deletes expired subject export files
  (see [subject-requests.md](subject-requests.md#export)).

## Replies

When a comment is purged, replies to it by other people are kept. Their parent
link is cleared and they are marked as having lost their parent. The comments
list shows **Reply to a removed comment** for them, and the API reports
`parentRemoved: true`. The reply text is not changed.

Purged comments are also fingerprinted, so a later poll or webhook delivery
from the platform does not ingest them again.

## Backups and replicas

Purging deletes from the live database. Copies in your backups remain until
the backups rotate out, and FeedBouncer does not touch them.

- Keep backups no longer than the shortest configured period plus 35 days.
- After restoring a backup, run the worker's purge (or `pnpm ops retention run`)
  before putting it into use, so data past its period does not come back.
- Read replicas follow the primary through WAL, so deleted rows leave them as
  the deletes replay. Deletion is not instant anywhere.

Backups also contain encrypted data you may no longer have keys for; see
[secrets.md](secrets.md#backups-and-restores).

## Logs

Service logs on stdout carry ids, counts and durations, not comment text,
author identifiers or handles. How long your log pipeline keeps them is up to
you; retention settings do not reach it.

## Rollback

Rolling back the migration (`down.sql` of `privacy_retention`) drops the
`privacy_request`, `erased_comment`, `retention_run`, `retention_confirmation`
and `retention_status` tables, the `comment.parent_removed_at` column and the
indexes added for the purge, and puts the append-only guard back. Comments,
decisions and audit events stay as they are. What is lost: the record of past
requests and runs, the fingerprints that stop erased or purged comments being
ingested again (so a poll can bring them back), and the "removed parent"
marker on replies. Roll back the worker and API at the same time.
