# @feedbouncer/jobs

Job queue foundation: per-platform queues, retries with jittered backoff,
idempotency through the `job_ledger` table and a dead-letter queue.

Postgres holds job state; Redis (BullMQ) only carries `{ v: 1, ledgerId }`.

- Operating it (queues, retry defaults, DLQ commands, retention): [docs/operations/job-queue.md](../../docs/operations/job-queue.md)
- Writing a job (idempotency keys, safe repeats, testing): [docs/jobs/defining-a-job.md](../../docs/jobs/defining-a-job.md)

## Modules

| File                 | Responsibility                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/policy.ts`      | `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `resolvePolicy`, `backoffDelayMs`, `leaseMs`, `retryHorizonMs` |
| `src/failure.ts`     | Failure classification, `decide` (retry, defer, dead-letter), `JobError`, `requireActionSuccess`      |
| `src/keys.ts`        | Tenant-scoped idempotency keys and BullMQ job ids                                                     |
| `src/payload.ts`     | Payload and result guards: plain JSON, size bound, no secret-like fields                              |
| `src/definition.ts`  | `JobDefinition`, `JobContext` and `JobRegistry`                                                       |
| `src/ledger.ts`      | `PgJobLedger`: claim with lease, retry bookkeeping, dead-letter, replay, purge                        |
| `src/queues.ts`      | `QueueSet`: one BullMQ queue per platform                                                             |
| `src/producer.ts`    | `JobProducer`: validated, deduplicated enqueue; replay; reconcile                                     |
| `src/runner.ts`      | The job processor: claim, run the handler, record the outcome                                         |
| `src/workers.ts`     | `JobWorkers`: one consumer per registered platform, plus the sweeper                                  |
| `src/config.ts`      | `loadJobsConfig` from the environment, and the dedup-window check                                     |
| `src/metrics.ts`     | `JobMetrics`: per-platform counters and structured log events                                         |
| `src/connections.ts` | Redis connections for workers and for producers                                                       |
| `src/cli/dlq.ts`     | Argument parsing and output for `pnpm jobs dlq list` / `replay`                                       |
| `src/bin.ts`         | CLI entry point (reads the environment, wires the pieces)                                             |
| `src/testing/`       | `createJobsHarness`, `ScriptedJob` and Postgres / Redis test helpers (`@feedbouncer/jobs/testing`)    |

## Commands

```bash
pnpm --filter @feedbouncer/jobs test               # unit tests
pnpm --filter @feedbouncer/jobs test:integration   # needs DATABASE_URL and REDIS_URL
pnpm jobs dlq list                                 # needs DATABASE_URL and REDIS_URL
```

The integration tests run against real Postgres and Redis and use throwaway tenants and
a throwaway Redis key prefix, so they are safe on a dev stack. They fail fast with a clear
message when `DATABASE_URL` or `REDIS_URL` is not set. Locally, start the stack with
`docker compose -f compose.yaml -f compose.expose-db.yaml up -d` and export `DATABASE_URL`
and `REDIS_URL` for the published ports. CI runs the same suite in the `API integration` job.
