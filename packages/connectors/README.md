# @feedbouncer/connectors

The connector framework: one documented contract for connecting a social
platform (OAuth, token refresh, reading comments, moderation actions, webhook
verification, rate-limit budget), plus the shared services that make every
connector safe to run. Connectors only translate platform HTTP into the
contract; tenancy, token storage, refresh serialization, budgets, signatures,
dedupe and output validation are done here. The package also ships a reference
connector and a conformance suite any connector can run.

To write one, start with [the guide](../../docs/connectors/writing-a-connector.md).
Operators: key removal and pending OAuth flows are covered in
[docs/operations/secrets.md](../../docs/operations/secrets.md#pending-oauth-flows).

## Modules

| File               | Responsibility                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`     | `PLATFORMS`, `MODERATION_ACTIONS`, `INVERSE_ACTION`, normalized types, `ConnectorCapabilities`, `ActionResult` |
| `src/errors.ts`    | `ConnectorError` (with `errorClass`), `ConnectorErrorInfo`, `toConnectorError`                                 |
| `src/schemas.ts`   | zod boundary schemas for everything a connector returns                                                        |
| `src/clock.ts`     | `Clock`, `systemClock`                                                                                         |
| `src/connector.ts` | The contract: `Connector`, `CallContext`, `OAuthContext`, `TokenSet`, `WebhookSpec`, `InboundEvent`            |
| `src/registry.ts`  | `ConnectorRegistry`, `validateConnector`                                                                       |
| `src/http.ts`      | `SafeHttp`, `createSafeHttp`, `assertAllowedUrl`, `parseRetryAfter`                                            |
| `src/budget.ts`    | `RateBudget`, `memoryBudget`, `redisBudget`                                                                    |
| `src/ports.ts`     | Storage port interfaces, `SyncRecorder` (per-connection sync health hook)                                      |
| `src/tokens.ts`    | `TokenManager`                                                                                                 |
| `src/oauth.ts`     | `OAuthFlow`, `OAuthAccessDeniedError`, `newPkcePair`, `hashState`                                              |
| `src/webhook.ts`   | `WebhookGate`, `WebhookOutcome`, `WebhookObserver` (intake span, delivery observer)                            |
| `src/runtime.ts`   | `ConnectorRuntime`, `ConnectionClient`, `isSuccessEquivalent`, `ConnectorCallObserver` (call spans, outcomes)  |
| `src/memory.ts`    | In-memory adapters for every port, `MemorySyncRecorder`                                                        |
| `src/pg/*.ts`      | Postgres adapters: vault, directory, refresh lock, OAuth state, membership, delivery ledger, webhook secrets   |
| `src/pg/sync.ts`   | `PgSyncRecorder`: writes `connection_sync`, copies tenant columns from the connection row, coalesces successes |
| `src/pg/stack.ts`  | `buildPgConnectorStack`: every adapter and service over Postgres and Redis, shared by the API and worker       |
| `src/reference/`   | `InMemoryPlatform` and `createReferenceConnector` (`push` and `poll` flavors)                                  |
| `src/testing/`     | `./testing` export: `runConnectorConformance`, `PlatformDriver`, in-memory stack and harness                   |
| `src/index.ts`     | Public exports                                                                                                 |

## Observability

The framework is instrumented at its choke points and stays free of any metrics or
tracing backend:

- `WebhookGate.handle` opens the `webhook.receive` root span and reports each delivery
  through a `WebhookObserver` (outcome, event count, event delay).
- `ConnectionClient` opens a `connector.<operation>` span per platform call and
  `moderation.apply` for actions, and reports each call through a `ConnectorCallObserver`.
- Read successes, accepted webhooks and failures are reported to a `SyncRecorder`;
  `PgSyncRecorder` stores them in `connection_sync`, which drives connector health.
- Span attributes are restricted to an allowlist and redacted; error spans carry codes, never messages.
  Telemetry callbacks that throw are swallowed and never fail the call.

The Prometheus and OpenTelemetry wiring lives in `@feedbouncer/observability`. Operator
reference: [docs/operations/observability.md](../../docs/operations/observability.md).

## Tests

```bash
pnpm --filter @feedbouncer/connectors test
pnpm --filter @feedbouncer/connectors test:integration   # needs DATABASE_URL and REDIS_URL
```
