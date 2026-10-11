# @feedbouncer/secrets

Envelope encryption for stored platform credentials (OAuth tokens, webhook
secrets), the typed key configuration, and the operator CLI.

## Architecture

Each credential is encrypted with AES-256-GCM under its own random data key
(DEK). The DEK is wrapped by a deployment key (key-encryption key) chosen by a
`KeyProvider`. The stored blob carries the id of the wrapping key, so decryption
selects the right key and rotation only re-wraps small data keys. Both layers
bind the record identity as additional authenticated data, so a blob copied to
another row, connection or tenant fails to open. Failures surface as a
`CredentialUnreadableError` with a reason (`unknown_key`, `tampered`,
`malformed`), never a crash and never a value.

Operator guide (generation, rotation, backup, recovery):
[docs/operations/secrets.md](../../docs/operations/secrets.md).

## Envelope v1 layout

All integers are big-endian.

| Offset | Size    | Field                                             |
| ------ | ------- | ------------------------------------------------- |
| 0      | 1       | Version, `0x01`                                   |
| 1      | 1       | Key id length N (1-32)                            |
| 2      | N       | Key id (ASCII), must equal the row's `key_id`     |
| 2+N    | 2       | Wrapped data key length W (the Keyring uses 60)   |
| 4+N    | W       | Wrapped data key (Keyring: IV 12, key 32, tag 16) |
| 4+N+W  | 12      | Data IV                                           |
| 16+N+W | 16      | Data GCM tag                                      |
| 32+N+W | 1-16384 | Ciphertext                                        |

The AAD strings (NUL is the separator, and ids containing NUL are rejected):

- Data: `fb-credential:v1\0<organizationId>\0<connectionId>\0<kind>`
- Data key wrap: `fb-dek:v1\0<keyId>\0<organizationId>\0<connectionId>\0<kind>`

`kind` is `access_token`, `refresh_token` or `webhook_secret`. The database
checks the envelope shape and the key id in the header
(`connection_secret_envelope_check`), so plaintext cannot be inserted.

## KeyProvider seam

`KeyProvider` (`wrap`, `unwrap`, `has`, `activeKeyId`) is the only thing the
envelope code needs. `Keyring` implements it from `FB_ENCRYPTION_KEYS`. A cloud
KMS or Vault adapter can implement the same interface later without changing
the envelope format, because the envelope records the wrapped key length.

## Rules for callers

- Read and write credentials only through `CredentialStore`. Wrap outbound
  platform calls in `withCredentials(scope, kinds, fn)`; values are decrypted
  per call and never cached.
- Call `reveal()` on a `Secret` only at the HTTP call site that needs the
  value.
- Never put a `Secret` in logs, audit details, error messages or API DTOs.
- When a credential cannot be read, call `markReconnectRequired` and handle the
  error; do not crash the worker.
- The maintenance functions (`reencryptAll`, `verifyAll`, `secretsStatus`,
  `recheckConnections`) read across tenants and are for the CLI only. Never
  call them from an HTTP handler.
- Tests use `@feedbouncer/secrets/testing` for throwaway keys.

## CLI

```text
pnpm secrets keygen [--id <key-id>]
pnpm secrets status
pnpm secrets verify
pnpm secrets reencrypt [--dry-run] [--batch-size <n>]
pnpm secrets recheck-connections [--dry-run]
```

Exit codes: 0 nothing left to do, 1 work or problems remain, 2 usage error.
See the operator guide for the rotation procedure.
