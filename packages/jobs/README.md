# @feedbouncer/jobs

Job queue foundation: per-platform queues, retries with jittered backoff,
idempotency through the `job_ledger` table and a dead-letter path.

## Modules

| File            | Responsibility                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `src/policy.ts` | `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `resolvePolicy`, `backoffDelayMs`, `leaseMs`, `retryHorizonMs` |
