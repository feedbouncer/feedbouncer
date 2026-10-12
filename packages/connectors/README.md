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
| `src/reference/`   | `InMemoryPlatform` and `createReferenceConnector` (`push` and `poll` flavors)                                  |
| `src/testing/`     | `./testing` export: `runConnectorConformance`, `PlatformDriver`, in-memory stack and harness                   |
| `src/index.ts`     | Public exports                                                                                                 |

## Tests

```bash
pnpm --filter @feedbouncer/connectors test
pnpm --filter @feedbouncer/connectors test:integration   # needs DATABASE_URL and REDIS_URL
```
