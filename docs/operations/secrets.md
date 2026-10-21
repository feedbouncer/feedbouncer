# Secrets and encryption keys

FeedBouncer stores platform OAuth tokens and webhook secrets only as encrypted
envelopes (AES-256-GCM). Each credential has its own random data key, which is
wrapped by your deployment's **encryption key**. Without the keys, a database
dump or backup holds no usable credential. **If you lose the keys, the stored
credentials cannot be recovered.**

## Settings

| Setting                       | Required                  | Meaning                                                                                                                                                                                |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FB_ENV`                      | no (default `production`) | `development`, `test` or `production`. Unset means production, which refuses the example values from `.env.example`. In development they only log a warning.                           |
| `FB_ENCRYPTION_KEYS`          | yes                       | Comma-separated `<key-id>:<base64 of 32 random bytes>` entries. Every listed key can decrypt. Up to 16. A key id is 1-32 lowercase letters, digits or dashes.                          |
| `FB_ENCRYPTION_ACTIVE_KEY_ID` | yes                       | The one key used for new encryption. Must be listed in `FB_ENCRYPTION_KEYS`.                                                                                                           |
| `<NAME>_FILE`                 | no                        | Read a secret from a mounted file instead of the environment. Absolute path, at most 64 KiB, one trailing newline (LF or CRLF) is removed. Set either `NAME` or `NAME_FILE`, not both. |

Settings that accept `<NAME>_FILE`:

- API: `DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`, `SMTP_URL`, `FB_ENCRYPTION_KEYS`,
  `FACEBOOK_APP_SECRET`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.
- Worker: `DATABASE_URL`, `REDIS_URL`, `SMTP_URL`, `FB_ENCRYPTION_KEYS`,
  `FACEBOOK_APP_SECRET`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN`.
- `pnpm secrets` commands: `DATABASE_URL`, `FB_ENCRYPTION_KEYS`.

`FB_ENCRYPTION_ACTIVE_KEY_ID` is a key id, not a secret, so it has no `_FILE`
form anywhere.

The API and worker validate all of these at startup and refuse to start on a
missing, malformed, too-short or example value. Errors name the setting and
never print its value.

## Running the CLI

Every `pnpm secrets <command>` below is the package's `cli` script. Pick the
form that fits where you run it. All of them need `DATABASE_URL`,
`FB_ENCRYPTION_KEYS` and `FB_ENCRYPTION_ACTIVE_KEY_ID` in the environment (or
the `_FILE` forms of the first two).

- **From a checkout** (your machine or a jump host with the database
  reachable): `pnpm secrets <command>`. It builds the package first
  (`tsc --build`), so the checkout must be writable and installed.
- **Inside the compose dev stack**: the containers already carry the database
  URL and keys, and pnpm is present, but `/repo` is owned by root, so
  `pnpm secrets` cannot write its build output there. Run the TypeScript source
  directly instead:

  ```sh
  docker compose exec api sh -c \
    'node_modules/.bin/tsx ../../packages/secrets/src/bin.ts status'
  ```

  (`NODE_OPTIONS=--conditions=@feedbouncer/source` is already set in dev
  containers, which makes workspace imports resolve to source.)

- **Inside a runtime image** (the default Dockerfile target; it has no pnpm, but
  ships the built workspace): run the compiled entry point from the app
  directory, with the same environment the service uses:

  ```sh
  docker compose exec worker node ../../packages/secrets/dist/bin.js status
  ```

  or `node /repo/packages/secrets/dist/bin.js status`.

The path `/repo/packages/secrets` depends on how your image is built; adjust
it to where the workspace lives in your image.

The CLI reads `FB_ENV` like the services do and **defaults to `production`**,
which refuses the example key from `.env.example`. For local use against the
dev example key, set `FB_ENV=development` (compose containers already have it
from `.env`).

Unknown flags and stray arguments are rejected with exit code 2 before anything
runs, so a mistyped `--dryrun` cannot turn into a real run.

## First-time setup

1. `pnpm secrets keygen --id k2026a` prints one line, for example
   `k2026a:<44 base64 characters ending in =>`. Without `--id` it uses a
   date-based id such as `k20261011`.
2. Set `FB_ENCRYPTION_KEYS=<that line>` and `FB_ENCRYPTION_ACTIVE_KEY_ID=k2026a`
   on **every** API and worker instance (same values everywhere).
3. Store the line in your password manager or secret store **separately from
   database backups**.

Docker secrets example (the API and the worker both need the keys):

```yaml
services:
  api:
    environment:
      FB_ENCRYPTION_KEYS_FILE: /run/secrets/fb_encryption_keys
    secrets: [fb_encryption_keys]
  worker:
    environment:
      FB_ENCRYPTION_KEYS_FILE: /run/secrets/fb_encryption_keys
    secrets: [fb_encryption_keys]
secrets:
  fb_encryption_keys:
    file: ./secrets/fb_encryption_keys # chmod 600, never committed
```

## Rotating keys (no downtime)

Rotation is a two-restart procedure. Do the steps in order; each restart can be
rolling.

1. **Add** the new key as decrypt-only: `pnpm secrets keygen --id k2026b`, then
   append it: `FB_ENCRYPTION_KEYS=k2026a:<key>,k2026b:<key>` (active stays
   `k2026a`). Restart every API and worker.
2. **Activate** it: `FB_ENCRYPTION_ACTIVE_KEY_ID=k2026b`. Restart every API and
   worker. New and refreshed tokens now use `k2026b`; old ones stay readable
   with `k2026a`.
   _Never skip step 1._ A process that does not yet have `k2026b` cannot read
   credentials written with it. It does not crash: the credential is reported
   as `unknown_key` and that connection is flagged `reconnect_required`. Once
   every process has the key, `pnpm secrets recheck-connections` restores
   them (see below).
3. **Re-encrypt** existing credentials: `pnpm secrets reencrypt --dry-run`, then
   `pnpm secrets reencrypt`. This is online, idempotent and resumable: if it is
   interrupted (Ctrl-C, crash), run it again. Rows changed concurrently by a
   token refresh are skipped safely; a second run picks them up. Ctrl-C stops
   it after the current batch. It prints `re-encrypting to active key <id>` at
   the start: check that this is the key you meant to activate before it goes
   on. Use `--batch-size <n>` (1-1000, default 100) to change the batch size.
4. **Confirm**: `pnpm secrets status` must show
   `key k2026a (retired): 0 credentials, safe to remove`.
5. **Remove** `k2026a` from `FB_ENCRYPTION_KEYS` and restart. Keep a backup of
   the retired key until no database backup that needs it is still retained.

The commands need `DATABASE_URL`, `FB_ENCRYPTION_KEYS` and
`FB_ENCRYPTION_ACTIVE_KEY_ID` (or their `_FILE` forms) in the environment, with
the **new** configuration from step 2.

## Command reference

```text
pnpm secrets keygen [--id <key-id>]
pnpm secrets status
pnpm secrets verify
pnpm secrets reencrypt [--dry-run] [--batch-size <n>]
pnpm secrets recheck-connections [--dry-run]
```

`keygen` prints only the key entry on stdout, so it can be piped into a secret
store; hints go to stderr. Results go to stdout, warnings and progress to
stderr. No command prints a credential value.

Exit codes: `0` success, `1` work or problems remain (or the command failed,
for example on a configuration error), `2` usage error. What counts as
"remaining" depends on the command:

- `reencrypt`: `0` only when no credential is left on a non-active key and none
  is unreadable. A `--dry-run` therefore exits `1` while anything would be
  rewrapped.
- `status`: `1` only when credentials need a key that is not configured, or a
  plaintext credential column exists. It exits `0` even while credentials still
  await re-encryption on a configured retired key; read the
  `credentials not on the active key` line.
- `verify`: `1` if any credential is unreadable.
- `recheck-connections`: `1` while any connection stays unreadable, has no
  credentials, or has no recorded previous status.

## Checking health

- `pnpm secrets status`: the active key, credential counts per key (retired keys
  show `safe to remove` at 0), keys that are `NOT CONFIGURED`, credentials not
  on the active key, connections needing reconnect, and
  `plaintext credential columns: 0`. Exit code 1 if credentials need an
  unconfigured key or a plaintext column exists.
- `pnpm secrets verify`: decrypts every stored credential (values are never
  printed) and lists unreadable ones by connection, organization, kind and
  reason (`unknown_key`, `tampered`, `malformed`).
- At startup, the API and worker log a warning if stored credentials reference
  a key that is not configured, and an info line if credentials are still
  waiting to be re-encrypted. Startup is never blocked by this check.

## Existing data / migration

Before this release no credentials were stored, so there is nothing to convert.
The database rejects any value that is not an encrypted envelope (constraint
`connection_secret_envelope_check`), and `pnpm secrets status` reports any
plaintext credential column (expected: 0).

## Backups and restores

- Database backups contain only ciphertext. A restored database is usable only
  with the keys that were configured when the data was written (see `status`).
- Back keys up separately: different system, different access list.
- Data removed by erasure or retention stays in backups until they rotate out; see
  [data-retention.md](data-retention.md#backups-and-replicas). Restoring one
  brings it back, so run the purge after a restore.
- After restoring an old backup, run `pnpm secrets status`. Any `NOT CONFIGURED`
  key must be restored from your key backup.

## Recovering from a lost or removed key

1. `pnpm secrets status` lists the missing key id and how many credentials need
   it. Affected connections are marked `reconnect_required` (reason
   `credential_unknown_key`) when they are next used, with an audit event that
   records the status they had before. Nothing crashes.
2. If you can find the key in a backup: add it back to `FB_ENCRYPTION_KEYS`,
   restart, then run `pnpm secrets recheck-connections --dry-run` and
   `pnpm secrets recheck-connections`. A connection whose credentials are
   readable again goes back to the status it had before it was flagged (a
   paused connection stays paused). Then run `pnpm secrets reencrypt` to move
   those credentials onto the active key.
3. If the key is gone for good: the affected brands must reconnect those
   platform accounts. Reconnecting overwrites the unreadable credential.

`recheck-connections` reports what it could not restore:

- `still unreadable with the configured keys`: a stored credential still cannot
  be opened. Restore the key or reconnect.
- `no stored credentials (reconnect required)`: nothing is stored for that
  connection. Only a reconnect fixes it.
- `previous status not recorded (left flagged)`: the credentials are readable but
  the pre-flag status is unknown, so the connection stays flagged and needs a
  reconnect. It is never guessed.

The command exits `1` while any of these remain.

## Pending privacy requests

A subject export or erasure request ([subject-requests.md](subject-requests.md))
keeps the identifiers it was asked about sealed in `privacy_request.subjects_sealed`,
with the same key ring, as a `privacy_subject` envelope. The request id is bound
into the envelope (in the slot used for the connection id elsewhere), so a blob
copied to another request cannot be opened. The column is cleared when the
request finishes or fails, so only pending requests hold one.

Unlike OAuth flows, these are counted: `pnpm secrets status` includes them in
the per-key counts, and `reencrypt` and `verify` cover them.

## Pending OAuth flows

While a user is connecting a platform account, the OAuth flow keeps a
short-lived PKCE verifier, sealed with the same envelope encryption and key
ring as connection credentials. A flow lives for at most 10 minutes.

If you remove an encryption key while a flow started under it is pending, that
callback fails closed (the user sees the connection was rejected) and the user
starts the connection again. Nothing else is affected.

These rows (`oauth_state`) are not counted by `pnpm secrets status`, and
`reencrypt` does not touch them, so a key reported as "safe to remove" can
still have pending flows. Removing it costs those users one restart. Waiting
10 minutes after the last use of a retired key avoids even that.

## Pending account-selection grants

Platforms where one authorization covers several accounts (Facebook Pages)
keep the person's user token between the OAuth callback and the moment they
pick accounts. That token is sealed as an `oauth_grant_token` envelope, bound
to the grant row, with the same key ring. A grant lives at most 30 minutes, is
single use, and expired rows are deleted the next time one is saved.

Like pending OAuth flows, these rows are not counted by `pnpm secrets status`
and `reencrypt` does not touch them. If you remove an encryption key while a
grant sealed under it is pending, opening it fails closed and the user starts
the connection again. Nothing else is affected. Waiting 30 minutes after the
last use of a retired key avoids even that. The Facebook app secret and webhook
verify token are not stored in the database; they come from the environment
(or `_FILE`) and are rotated by changing them there and restarting.

## Tampered or corrupted credentials

A credential that fails its integrity check is never used. Its connection is
marked `reconnect_required` (reason `credential_tampered`) and audited, and the
brand must reconnect. Investigate how the row changed: it can only happen
through direct database writes. `recheck-connections` will not restore such a
connection, because its credential stays unreadable.

Reusing a key id with different key material has the same effect: the id still
matches, so the old credentials are read with the wrong key and fail as
tampered (not `unknown_key`). Never recycle a key id; generate a new one.

## Development and tests

`.env.example` ships a public example key (`dev-example`) and sets
`FB_ENV=development`. Development accepts the example values with a warning;
production refuses them. Tests generate throwaway keys
(`@feedbouncer/secrets/testing`) and never use real credentials. CI fails if an
env file other than `.env.example` is committed.

## Troubleshooting

| Symptom                                                                            | Fix                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `... is set to a documented example value from .env.example` at startup            | `FB_ENV` is unset or `production`, and a setting still has the example value. A `.env` copied from an older `.env.example` has no `FB_ENV`, and compose defaults it to `production`. For a local stack add `FB_ENV=development`; for a real deployment generate real values. |
| `FB_ENCRYPTION_ACTIVE_KEY_ID names a key id that is not in FB_ENCRYPTION_KEYS`     | Add the active key to `FB_ENCRYPTION_KEYS`, or fix the id.                                                                                                                                                                                                                   |
| `FB_ENCRYPTION_KEYS key "<id>" must be exactly 32 random bytes in standard base64` | Generate the entry with `pnpm secrets keygen`; do not edit or truncate it.                                                                                                                                                                                                   |
| `Set either NAME or NAME_FILE, not both`                                           | Remove one of the two.                                                                                                                                                                                                                                                       |
| `NAME_FILE points to a file larger than 65536 bytes` / `must be an absolute path`  | Mount a single small file and use its absolute path.                                                                                                                                                                                                                         |
| `pnpm secrets status` shows a key as `NOT CONFIGURED`                              | See "Recovering from a lost or removed key".                                                                                                                                                                                                                                 |
| Connections flagged `credential_unknown_key` during a rotation                     | A process was missing the new key. Make sure every API and worker has it, then run `pnpm secrets recheck-connections`.                                                                                                                                                       |
