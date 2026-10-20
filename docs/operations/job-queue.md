# Job queue operations

The worker runs platform work (moderation actions, reads) through one queue per
platform. Postgres (`job_ledger`) holds the state of every job; Redis (BullMQ)
only carries a pointer `{ v: 1, ledgerId }`. Comment text never sits in Redis.

For how to write a job, see [docs/jobs/defining-a-job.md](../jobs/defining-a-job.md).

## Queues

- Queue name: `platform-<platform>` under the Redis key prefix `JOB_QUEUE_PREFIX` (default `fb`).
- One consumer per platform registered in the worker's `ConnectorRegistry`
  (`apps/worker/src/registries.ts`). Registering a connector provisions its queue.
  A deployment with no connectors registered runs no platform queues; the worker logs
  `job consumers ready` with `platforms: none`.
- Platforms are isolated: each has its own BullMQ worker and concurrency, so a stalled
  or failing platform does not delay another.
- Concurrency: `JOB_CONCURRENCY` (default 2), overridden per platform by
  `JOB_CONCURRENCY_<PLATFORM>` (for example `JOB_CONCURRENCY_FACEBOOK`). `0` means this
  process does not consume that platform's queue.
- Lanes: slow work runs on `lane-<lane>-<platform>` queues so it cannot delay connector
  jobs. The `classify` lane (comment classification) has `JOB_CONCURRENCY_LANE_CLASSIFY`
  consumers per platform (default 4, `0` off; keep it above `CLASSIFIER_BRAND_MAX_IN_FLIGHT`,
  the worker warns at startup otherwise). Lane consumers start only for platforms whose own
  concurrency is above 0. The classifier itself is configured with
  `CLASSIFIER_PROVIDER`, `CLASSIFIER_MODEL`, `CLASSIFIER_API_KEY` (or `_FILE`),
  `CLASSIFIER_BASE_URL`, `CLASSIFIER_ALLOW_HTTP`, `CLASSIFIER_TIMEOUT_MS` (1000..25000,
  default 10000), `CLASSIFIER_LANGUAGES` (default `en,es,pt,fr,de,it,nl`),
  `CLASSIFIER_BRAND_MAX_IN_FLIGHT` (1..16, default 2) and `CLASSIFIER_MAX_WAIT_MINUTES`
  (1..90, default 30); see `.env.example`. DLQ replay routes lane jobs to their lane queue.
- The `policy` lane (custom policy checks and previews) has
  `JOB_CONCURRENCY_LANE_POLICY` consumers per platform (default 4, `0` off; keep it above
  `POLICY_BRAND_MAX_IN_FLIGHT`, the worker warns at startup otherwise). Policies use the
  classifier's model and key unless `POLICY_PROVIDER` is set, in which case
  `POLICY_PROVIDER`, `POLICY_MODEL`, `POLICY_API_KEY` (or `_FILE`), `POLICY_BASE_URL` and
  `POLICY_ALLOW_HTTP` configure their own; `POLICY_PROVIDER=none` turns policy checks off.
  Also `POLICY_TIMEOUT_MS` (1000..25000, default 15000), `POLICY_BRAND_MAX_IN_FLIGHT`
  (1..16, default 2), `POLICY_MAX_WAIT_MINUTES` (1..240, default 60) and
  `POLICY_MONTHLY_CALLS_PER_BRAND` (default 20000, `0` stops checks); see `.env.example`.

## Retry policy

| Setting                             | Default         | Env                   |
| ----------------------------------- | --------------- | --------------------- |
| `maxAttempts` (failures, crashes)   | 8               | `JOB_MAX_ATTEMPTS`    |
| Backoff base delay                  | 5 s             | `JOB_BACKOFF_BASE_MS` |
| Backoff cap                         | 15 min          | `JOB_BACKOFF_MAX_MS`  |
| Jitter                              | equal (50-100%) | none                  |
| Rate-limit deferrals (not failures) | 100             | code only             |
| Total time deferred by rate limits  | 24 h            | code only             |
| Handler timeout                     | 60 s            | per job type, in code |
| Worker lease                        | timeout + 30 s  | derived               |

Overrides apply in this order, later wins: environment default, then per job type
(`JobDefinition.policy`). Every resolved policy is validated, and a bad value fails
the worker at startup.

Backoff before retry `n` is `min(cap, base * 2^(n-1))`, then jittered into the upper
half: `[exp/2, exp]`. With the defaults the delays are about 2.5-5 s, 5-10 s, 10-20 s,
20-40 s, and so on, up to 7.5-15 min.

A rate-limited job waits at least the platform's `retry-after` (the platform hint may
exceed the backoff cap) and does not use up an attempt. It is dead-lettered with
`rate_limit_exhausted` only when the deferral count or total deferred time is exceeded.

## Error classes

| Class                                       | Examples                                                                                     | Outcome                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Transient                                   | 5xx, network error, timeout, unexpected error                                                | Retry with backoff; DLQ `retries_exhausted`        |
| Rate limited                                | 429, platform quota                                                                          | Defer by `retry-after`; DLQ `rate_limit_exhausted` |
| Credential expired, fixable by reconnecting | `auth_expired` after the one refresh attempt                                                 | DLQ `needs_reconnection`, no retries               |
| Non-retryable                               | other 4xx, malformed response, unsupported, a revoked connection (reconnecting can't fix it) | DLQ `non_retryable`                                |
| Target gone                                 | 404 on a replayed job                                                                        | Row becomes `resolved` (`target_gone`)             |
| Invalid job                                 | payload fails its schema, unknown job type                                                   | DLQ `invalid_job`                                  |
| Poison job (crashes the worker)             | process dies mid-run, repeatedly                                                             | DLQ `stall_limit_exceeded` after `maxAttempts`     |

## Dead-letter queue

The DLQ is the set of `job_ledger` rows in state `dead_lettered`, so retention and the
dedup window cannot drift apart. Each entry keeps the payload, platform, tenant, job
type, idempotency key, attempt counters, timestamps and the final error kind and code
(never the raw error message).

Commands (run from the repository root with `DATABASE_URL` and `REDIS_URL` set, or the
`*_FILE` variants):

```bash
# List (one JSON object per line; default state dead_lettered, default limit 50)
pnpm jobs dlq list --platform facebook --reason needs_reconnection --limit 20
pnpm jobs dlq list --organization <uuid> --since 2026-10-01T00:00:00Z
pnpm jobs dlq list --state resolved
pnpm jobs dlq list --show-payload        # payloads may contain comment text

# Replay one or more entries by id
pnpm jobs dlq replay --id <uuid> --id <uuid>

# Bulk replay needs --platform and --yes; preview first with --dry-run
# (the preview lists the oldest rows first, the order replay takes them in)
pnpm jobs dlq replay --platform facebook --reason needs_reconnection --dry-run
pnpm jobs dlq replay --platform facebook --reason needs_reconnection --yes
```

Filters: `--platform`, `--organization` (limits the command to one tenant), `--reason`,
`--since` (ISO date), `--limit` (list 1-500, replay 1-10000). Replay prints
`{"replayed": <n>}` and resets the attempt counters. It reuses the original idempotency
key, so replaying the same entry twice, even at once, enqueues it once.

Errors go to stderr as `jobs dlq: <message>` (exit 1; exit 2 for a usage error). A
rejected filter value is never echoed.

What to do per reason:

| Reason                                      | Action                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `needs_reconnection`                        | Reconnect the account in the app, then replay with `--reason needs_reconnection`.        |
| `retries_exhausted`, `rate_limit_exhausted` | Usually a platform outage or quota. Bulk replay once the platform has recovered.         |
| `stall_limit_exceeded`                      | Poison job. Inspect with `--show-payload` and fix the handler before replaying.          |
| `invalid_job`                               | Code or data bug. Fix, then replay; replaying unchanged fails the same way.              |
| `non_retryable`                             | The platform refused the action. Check the error code; replay only if the cause changed. |
| `resolved` (`target_gone`)                  | No action: the comment is gone, so there is nothing left to do.                          |

## Retention and the dedupe window

- `JOB_DLQ_RETENTION_DAYS` (default 14): the minimum time a dead-lettered or resolved row
  is kept, counted from when it was dead-lettered.
- `JOB_DEDUP_WINDOW_DAYS` (default 30): how long a row, and therefore its idempotency key,
  lives, counted from enqueue. While the row exists, the same logical job cannot run again.
- A row is purged at the later of the two. With the defaults a job that is dead-lettered
  soon after enqueue is kept for about 30 days, not 14.
- Startup fails if the window is shorter than the longest retry period plus DLQ
  retention for any registered platform and job type. Too short and a replay could find
  its row purged, or a duplicate could slip in; too long only grows storage.
- `queued` rows are never purged. The sweeper purges expired settled rows, up to 1,000
  per sweep, once a minute.
- Claim times (`first_claimed_at`, `last_claimed_at`) are kept for evaluation; they are purged with the row.

## Redis loss

If Redis restarts and loses its data, only pointers are lost. The sweeper re-adds
`queued` rows that have been idle for `staleAfterMs` (5 min). The BullMQ job id derives
from the idempotency key, so re-adding a job that still exists is harmless.

## Shutdown

On `SIGTERM` the worker stops taking jobs and waits for in-flight handlers (bounded by
their timeouts). Scheduled retries live in Redis and Postgres and survive a restart.
Keep the container's `stop_grace_period` above the longest handler timeout plus margin
(`compose.yaml` uses 100 s).

A crash between a successful platform call and recording the result re-runs the
handler, so handlers must be safe to repeat. See the contributor guide.

A handler that ignores its abort signal is parked once its timeout passes: the worker
frees the slot but keeps the job's lease until the handler returns, then records the retry.
A retry never overlaps the original run unless the lease itself expires first.

## Observability

Structured log events, each with `platform`, `jobType` and `ledgerId`:

`job.enqueued`, `job.deduplicated`, `job.completed`, `job.retried`, `job.deferred`,
`job.dead_lettered` (adds `reason`, `code`), `job.replayed`, `job.duplicate_delivery`,
`job.requeued`.

Lines written while a job is in scope also carry the snake_case correlation keys
`connector_type`, `job_id`, `tenant_id` and `brand_id` and, when tracing is active,
`trace_id` and `span_id`. The
worker's periodic sweep logs `job.stats` with the requeued and purged counts and a
counter per platform and event, named `<platform>_<event>` (for example
`facebook_dead_lettered`).

The same events are exported as `feedbouncer_jobs_total{queue,job_type,outcome}` on the
worker's `/metrics`, together with `feedbouncer_queue_wait_seconds`,
`feedbouncer_queue_depth` and `feedbouncer_queue_oldest_age_seconds`. Queue depth and age
are recomputed from `job_ledger` on each scrape, so they survive restarts. Field and
metric reference and trace propagation through `job_ledger.trace_context`:
[observability.md](observability.md).

## Privacy

Payloads can contain comment text. They are kept for the lifetime of the row (see
[Retention](#retention-and-the-dedupe-window)) and never contain
credentials: enqueue rejects secret-like fields, and only error kinds and codes are
stored or logged. Erasing a person's data ([subject-requests.md](subject-requests.md))
deletes finished ledger rows that refer to their comments; rows still queued or running
are left, and the worker skips them because the comment is gone. The retention purge
deletes finished rows by age (`RETENTION_OPERATIONAL_DAYS`, see
[data-retention.md](data-retention.md)).
