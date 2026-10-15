# Defining a job

A job is a unit of platform work that must run once, survive retries and be safe
to redeliver. Operators: see [docs/operations/job-queue.md](../operations/job-queue.md).

## Example

```ts
import { z } from 'zod';
import type { ConnectorRuntime } from '@feedbouncer/connectors';
import { JobError, requireActionSuccess, type JobDefinition } from '@feedbouncer/jobs';

const payload = z.strictObject({
  sourceId: z.string().min(1).max(256),
  commentId: z.string().min(1).max(256),
});

export const hideComment = (runtime: ConnectorRuntime): JobDefinition<z.infer<typeof payload>> => ({
  type: 'hide_comment',
  platforms: 'all',
  payload,
  externalRef: (p) => `${p.commentId}:hide`,
  handle: async (ctx, p) => {
    const client = await runtime.connect(ctx.scope);
    const comment = await client.getComment({
      sourceExternalId: p.sourceId,
      externalId: p.commentId,
    });
    if (comment === null) throw new JobError('non_retryable', 'target_not_found');
    const result = await client.act({
      action: 'hide',
      target: { sourceExternalId: p.sourceId, externalId: p.commentId },
    });
    return requireActionSuccess(result);
  },
});
```

## Rules

- **Payload:** a `z.strictObject` with JSON types only (no `z.date()`). The payload is
  validated at enqueue and again on every run. Maximum 64 KiB.
- **No secrets in payloads.** Tokens and credentials never go in a payload, a result
  or an error message. Enqueue rejects secret-like field names and `Secret` values.
- **`externalRef`:** build it from the platform's identity plus the action
  (`<commentId>:hide`), so a webhook, a poll and a retry of the same logical job
  collapse into one. Never use a timestamp or random id.
- **Idempotency key:** SHA-256 over organization, brand, connection, platform, job
  type and `externalRef`, so two tenants with the same comment id never collide.
- **Safe to repeat.** The handler runs again if the process dies after the platform call
  succeeds but before the result is recorded. Check before acting, and treat "already
  done" as success (`requireActionSuccess` maps `already_absent` for you). A crash after
  the result is recorded is fully covered.
- **Pass `ctx.signal`** to every outbound call; it aborts at the job's `timeoutMs`
  (default 60 s, range 1-600 s). A handler that ignores it keeps running, and its retry
  waits until it returns or its lease (timeout + 30 s) expires.
- **Fail with a classified error.** Throw `ConnectorError` (the connector framework's
  kinds) or `JobError('retryable' | 'non_retryable', code)`. Anything else is treated as a
  retryable `unexpected_error`. Messages are never stored; only kind and code are.
- **Return a small result** (flat, at most 8 KiB). Include the undo action so the
  outcome is explainable and reversible. `requireActionSuccess` does this.

## Built-in jobs

| Type                  | Platforms           | Payload              | `externalRef`                | Timeout |
| --------------------- | ------------------- | -------------------- | ---------------------------- | ------- |
| `connection_backfill` | facebook, instagram | `{ runId, segment }` | `backfill:<runId>:<segment>` | 300 s   |

`connection_backfill` imports a connection's recent comments after connect; it
continues itself in a new segment before its timeout. See
[backfill.md](../connectors/backfill.md).

| Type            | Platforms | Payload                              | `externalRef`         | Timeout |
| --------------- | --------- | ------------------------------------ | --------------------- | ------- |
| `rule_evaluate` | all       | `{ commentId, bodySha256, trigger }` | `<commentId>:<sha[0..32]>` | 30 s    |

`rule_evaluate` applies a brand's moderation rules to one version of a comment's
text. See [rules.md](../moderation/rules.md).

## Registering and enqueuing

Register definitions in `apps/worker/src/registries.ts` (`buildJobRegistry`). A platform
gets a queue when its connector is registered in `buildConnectorRegistry`.

Enqueue through `JobProducer.enqueue({ scope, platform, type, payload })` after the
caller has been authorised for that organization, brand and connection. The producer
checks that the connection belongs to exactly that tenant and platform. The result is
`enqueued` or `deduplicated`; both are success.

Pass `idempotencyKey` only when no stable `externalRef` exists; it is hashed with the
same tenant scope.

## Testing

`@feedbouncer/jobs/testing` provides `createJobsHarness()`, which starts real
Postgres- and Redis-backed workers over the reference Facebook and YouTube connectors,
plus `ScriptedJob`, a job whose steps (`ok`, failures, `hang`, ...) you choose in the
payload to script a whole retry history. Integration tests need `DATABASE_URL` and
`REDIS_URL`:

```bash
pnpm --filter @feedbouncer/jobs test:integration
```

See `packages/jobs/src/workers.integration.test.ts` for the pattern.
