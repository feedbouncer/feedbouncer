# @feedbouncer/db

SQL-first Postgres migrations and the core data model for FeedBouncer.

## How migrations work

Prisma is only the runner. It provides `prisma migrate deploy`, the
`_prisma_migrations` ledger and an advisory lock. The schema itself is plain SQL
that we write by hand, because composite foreign keys with
`ON DELETE SET NULL (column)`, triggers and CHECK constraints cannot be expressed
in `schema.prisma`, which holds only the datasource.

Each directory under `prisma/migrations/` holds two files:

- `migration.sql` moves the schema forward.
- `down.sql` reverses it exactly, in reverse order.

There is no Prisma model and no Prisma Client. That is why `prisma migrate dev`,
`prisma migrate reset` and `prisma db push` are forbidden (a guard test fails if
a package script calls them): against a schema with no models they would generate
`DROP TABLE` for everything.

### Migration atomicity

Prisma 7.10.0 applies `migration.sql` one statement at a time, not as a single
implicit transaction (verified by the failing-migration case in
`src/migrations/workflow.integration.test.ts`). Every `migration.sql` is
therefore wrapped in an explicit `BEGIN;` ... `COMMIT;`, and `files.test.ts`
enforces it for every migration after `20261010000000_processed_job`, which is a
single statement and predates the rule. New migrations must keep both. `down.sql` must not contain
transaction control: `migrate:down` runs it inside its own transaction.

## Commands

| Task                               | Command                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| Apply pending migrations (Compose) | `docker compose run --rm migrate` (also runs on every `docker compose up`) |
| Apply pending migrations (host)    | `pnpm db:migrate`                                                          |
| Roll back the newest migration     | `pnpm db:rollback --yes-destroy-data`                                      |
| Create a migration                 | `pnpm db:migration:new add_widget`, then edit both files                   |
| Status                             | `pnpm db:status`                                                           |
| Integration tests                  | `pnpm --filter @feedbouncer/db test:integration`                           |

`pnpm db:rollback` without the flag prints a refusal and exits with status 2.
Rolling back runs `down.sql` and can destroy data, hence the flag.

The host commands need Postgres published on the host:

```bash
docker compose -f compose.yaml -f compose.expose-db.yaml up -d postgres
set -a; . ./.env; set +a
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB}"
```

Integration tests create and drop their own `fb_test_*` databases and never touch
your data. The one exception is `job-once.integration.test.ts`, which uses the
database named in `DATABASE_URL` directly and needs it to be migrated already.
The user in `DATABASE_URL` must be allowed to create databases.

## Existing local databases

No reset is needed. `docker compose up` (or `docker compose run --rm migrate`)
applies the pending migrations on top of `processed_job`, and existing
`processed_job` rows are kept.

## Writing a migration

- Scaffold with `pnpm db:migration:new <name>` and write both files. Directory
  names are `<14 digit timestamp>_<snake_case_name>`.
- Wrap `migration.sql` in `BEGIN;` ... `COMMIT;` and open it with
  `SET LOCAL lock_timeout = '10s';`. `down.sql` has no transaction control.
- Never use `CREATE INDEX CONCURRENTLY`; it cannot run inside a transaction. A
  new index on a large table later needs a separate, reviewed procedure.
- State `ON DELETE` on every `REFERENCES` clause (a static guard checks it).
- `down.sql` reverses the migration in reverse order and does not use
  `IF EXISTS`, so a half-applied state fails loudly.
- Naming: snake_case singular tables, and keep every identifier within 63
  bytes, because Postgres silently truncates longer ones.
  - Constraints: `<table>_pkey`, `<table>_<cols>_key`, `<table>_<cols>_fkey`,
    `<table>_<what>_check`.
  - Indexes: `<table>_<cols>_idx`.
  - Triggers: `<table>_<purpose>_trg`.
  - Functions: `fb_<verb>_<noun>()`.
- Every table has `created_at` and `updated_at` (`timestamptz(3)`), except
  immutable link tables whose rows are only inserted or deleted (`comment_tag`,
  `comment_done`, `role_grant`), which keep a single event timestamp. Every tenant
  table has `organization_id`, and every foreign key has an index whose first
  column is the pointer column.
- Never edit a migration that has been applied anywhere. Add a new one.

## Recovering from a failed migration

Because Prisma applies the file statement by statement but the file is wrapped in
an explicit transaction, a failure rolls the schema back to where it was and
leaves the ledger row unfinished.

Prisma's own output for that failure is only `current transaction is aborted,
commands ignored until end of transaction block`, not the original error. To find
the cause, either read the Postgres server log (`docker compose logs postgres`),
where the real `ERROR:` precedes that message, or replay the file:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/prisma/migrations/<name>/migration.sql
```

Fix the SQL, then mark the attempt as rolled back and deploy again:

```bash
pnpm --filter @feedbouncer/db exec prisma migrate resolve --rolled-back <name>
pnpm db:migrate
```

## Concurrency

Prisma's advisory lock `72707369` serializes `migrate deploy`, and `migrate:down`
takes the same lock, so deploy and rollback never interleave. In Compose, the API
and worker wait for the one-shot `migrate` service to finish.

## Data model

Every table except `processed_job`, `connection_sync` (keyed by `connection_id`), `meta_ad_source`, `meta_ad_listing`, `source_poll`, `comment_tag`, `comment_done`, `role_grant`, `alert_brand_settings`, `alert_route`, `alert_brand_state`, `alert_negative_hourly` and `alert_flag_item` has
`id uuid` (`gen_random_uuid()`), `created_at`
and `updated_at`. Tenant tables carry `organization_id`, brand-scoped tables also
carry `brand_id`, and each child foreign key includes its parent's scope columns,
so the database refuses cross-tenant links.

| Table                   | Purpose                                                                                                                                                                                                                                          | Tenant scope                           | Natural key                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------- |
| `organization`          | The tenant (workspace) boundary.                                                                                                                                                                                                                 | itself                                 | none                                        |
| `app_user`              | A person who can sign in. Not named `user`, which is reserved in Postgres.                                                                                                                                                                       | global                                 | `lower(email)`                              |
| `auth_session`          | A sign-in session. Owned by Better Auth through field mapping.                                                                                                                                                                                   | global                                 | `token`                                     |
| `auth_account`          | A credential (password hash) for a user. Owned by Better Auth through field mapping.                                                                                                                                                             | global                                 | `(provider_id, account_id)`                 |
| `auth_verification`     | Short-lived verification values. Owned by Better Auth through field mapping.                                                                                                                                                                     | global                                 | none                                        |
| `invitation`            | An invitation to join an organization with a role.                                                                                                                                                                                               | `organization_id`                      | `(organization_id, email)` where pending    |
| `membership`            | Links a user to an organization with a role (`owner`, `admin`, `member`).                                                                                                                                                                        | `organization_id`                      | `(organization_id, user_id)`                |
| `brand`                 | A client or brand inside an organization.                                                                                                                                                                                                        | `organization_id`                      | none                                        |
| `connection`            | A connected platform account for a brand. `status` includes `reconnect_required` (with `status_reason`, e.g. `credential_tampered`).                                                                                                             | `organization_id`, `brand_id`          | `(brand_id, platform, external_account_id)` |
| `connection_secret`     | Envelope-encrypted platform credential (`access_token`, `refresh_token`, `webhook_secret`). Ciphertext only; see `docs/operations/secrets.md`.                                                                                                   | org, brand, connection                 | `(connection_id, kind)`                     |
| `oauth_state`           | Pending OAuth authorization: SHA-256 of the state, envelope-encrypted PKCE verifier, single-use, at most 1 h.                                                                                                                                    | org, brand, user (optional connection) | `state_hash`                                |
| `oauth_grant`           | Multi-account OAuth grant: user token envelope-encrypted (`oauth_grant_token`), single-use pick-a-page step, at most 1 h.                                                                                                                        | org, brand, user (optional connection) | none (`id`)                                 |
| `moderation_action`     | A platform moderation action on a comment. Status: `pending`, then `applied`, `noop`, `not_eligible` or `failed`. One private reply per comment.                                                                                                 | org, brand, connection                 | `(organization_id, request_key)`            |
| `source`                | A post, ad, video or thread on a connection.                                                                                                                                                                                                     | org, brand, connection                 | `(connection_id, external_id)`              |
| `author`                | A commenter's platform identity, scoped to a connection (platform user IDs are not global).                                                                                                                                                      | org, brand, connection                 | `(connection_id, external_id)`              |
| `comment`               | A comment on a source. `body` is unbounded text. Optional parent under any source of the same connection.                                                                                                                                        | org, brand, connection, source         | `(connection_id, external_id)`              |
| `meta_ad`               | An ad discovered through a `meta_ads` connection (one ad account), with its resolved Facebook/Instagram post ids and active state. `name` is optional (1 to 200 characters); `deleted_at` and `status_checked_at` are NULL until set.            | org, brand, ads connection             | `(ads_connection_id, external_id)`          |
| `meta_ad_source`        | Links an ad to the source(s) it shows. Keyed by `(ad_id, source_id)`, no `id`. `unlinked_at` is a soft unlink: NULL while the link is live.                                                                                                      | org, brand, ad, source                 | `(ad_id, source_id)`                        |
| `meta_ad_listing`       | An ad listing in progress for a meta_ads connection: resume cursor and start time. Keyed by `ads_connection_id`, no `id`.                                                                                                                        | org, brand, connection                 | `ads_connection_id`                         |
| `source_poll`           | Comment polling state per source (cursor, high-water mark, schedule). Keyed by `source_id`, no `id`.                                                                                                                                             | org, brand, connection, source         | `source_id`                                 |
| `rule`                  | A brand's moderation rule: conditions, action, mode, priority, `enabled`.                                                                                                                                                                        | `organization_id`, `brand_id`          | none                                        |
| `decision`              | One append-only moderation outcome for a comment, with actor, reason and optional classifier fields.                                                                                                                                             | `organization_id`, `brand_id`          | none (`id`)                                 |
| `tag`                   | A workspace tag. `name` is what people see (1 to 50 characters, trimmed); `name_key` is the case-folded form used for uniqueness.                                                                                                                | `organization_id`                      | `(organization_id, name_key)`               |
| `comment_tag`           | Puts a tag on a comment. Keyed by `(comment_id, tag_id)`, no `id`.                                                                                                                                                                               | org, brand, comment, tag               | `(comment_id, tag_id)`                      |
| `comment_done`          | Marks a comment as done, with who and when. Keyed by `comment_id`, no `id`.                                                                                                                                                                      | org, brand, comment                    | `comment_id`                                |
| `role_grant`            | Extra capability granted to a role in an organization. Only `(member, comment.reply)` is allowed. Keyed by `(organization_id, role, capability)`, no `id`.                                                                                       | `organization_id`                      | `(organization_id, role, capability)`       |
| `alert_channel`         | An alert destination: a Slack incoming webhook (sealed URL, `alert_slack_webhook`) or an email address (double opt-in, sealed unsubscribe token, `alert_unsubscribe_token`). Only SHA-256 hashes of the confirm and unsubscribe keys are stored. | `organization_id`                      | none (`id`); email unique per organization  |
| `alert_brand_settings`  | Per-brand spike sensitivity, minimum negative count, cooldown and content mode. Keyed by `brand_id`, no `id`.                                                                                                                                    | org, brand                             | `brand_id`                                  |
| `alert_route`           | Sends one alert type of a brand to one channel. Keyed by `(brand_id, alert_type, channel_id)`, no `id`.                                                                                                                                          | org, brand, channel                    | `(brand_id, alert_type, channel_id)`        |
| `alert_brand_state`     | Spike evaluator state per brand (next evaluation, episode, cooldown, last verdict). Keyed by `brand_id`, no `id`.                                                                                                                                | org, brand                             | `brand_id`                                  |
| `alert_negative_hourly` | Hourly negative and total comment counts per brand, the spike baseline. Keyed by `(brand_id, hour)`, no `id`.                                                                                                                                    | org, brand                             | `(brand_id, hour)`                          |
| `alert_event`           | One alert to send (`negative_spike`, `spike_escalation`, `flagged_digest`, `cap_reached`). `cap_reached` has no brand. `payload` is a JSON object of at most 16 KiB.                                                                             | org, optional brand                    | `(organization_id, alert_key)`              |
| `alert_delivery`        | One send of an event to a channel: state, attempts (0 to 6), lease and error code. No payload or secrets.                                                                                                                                        | org, event, channel                    | `(alert_event_id, channel_id)`              |
| `alert_flag_item`       | A flagged review item waiting for the next digest. Keyed by `review_item_id`, no `id`.                                                                                                                                                           | org, brand, review item, comment       | `review_item_id`                            |
| `audit_event`           | Append-only record of significant changes.                                                                                                                                                                                                       | `organization_id`, optional brand      | none (`id`)                                 |
| `job_ledger`            | One row per logical platform job: payload, state, retry counters, lease, effect record, DLQ metadata, and `trace_context` (W3C traceparent, nullable) (packages/jobs).                                                                           | org, brand, connection                 | `(organization_id, idempotency_key)`        |
| `connection_sync`       | Last sync outcome per connection (observability). No secrets or content.                                                                                                                                                                         | org, brand, connection                 | `connection_id`                             |
| `processed_job`         | Idempotency ledger for background jobs (system table, no tenant).                                                                                                                                                                                | none                                   | `(queue, job_id)`                           |

Facebook Pages: at most one live (non-`revoked`) `facebook` connection may own a
Page across all tenants (`connection_facebook_live_external_account_id_key`),
because Meta allows one app subscription per Page. Revoked connections keep their
history and do not count.

`comment` also carries `is_own_account` (the author is the connected account),
`permalink` (https URL, at most 2048 characters) and `platform_synced_at` (last
time the platform copy was read).

`connection.granted_scopes` holds the OAuth scopes the platform granted (at most
100, no NULL elements).

`connection.status_reason` values in use:

- `credential_unknown_key`, `credential_tampered`, `credential_malformed`: set by
  `@feedbouncer/secrets` when a stored credential cannot be read.
- `user_disconnected`: the user disconnected the connection (status `revoked`).
- `oauth_pending`, `oauth_refresh_rejected`, `oauth_access_rejected`,
  `oauth_not_refreshable`, `setup_not_queued`: set by `@feedbouncer/connectors`.

`pnpm secrets recheck-connections` only reverses `credential_*`; `oauth_*` is
reversed by re-authorizing the connection.

Ingestion is idempotent: writers use `INSERT ... ON CONFLICT (<natural key>) DO
NOTHING`, so a webhook and a poller inserting the same comment produce one row.
Comments are edited in place (`body` overwritten, `updated_at` bumps). There is
no soft deletion; a platform-side deletion is state
(`comment.platform_state = 'deleted'`).

`comment.parent_external_id` is kept even when the parent row is missing or
deleted, so replies can be linked later. Writers must keep `parent_comment_id`
and `parent_external_id` consistent; the database does not cross-check them.

### Review mode

For 168 hours after a connection is set up, automation only suggests: it records
what it would have done and waits for a person.

`connection` columns:

- `review_mode`: `legacy` (connected before this feature, never gated), `on`
  (the default for new rows) or `opted_out`.
- `review_mode_started_at`, `review_mode_ends_at`: the window. Both set or both
  NULL, and only while `review_mode = 'on'`. `ends_at` is exactly `started_at +
168 hours`.
- `review_mode_ended_at`, `review_mode_ended_by_user_id`: set when a person ends
  the window early. Requires `review_mode = 'on'` and a started window.
- `review_mode_ended_pending`: what the person chose for pending suggestions
  (`leave`, `dismiss` or `approve`); only set together with `review_mode_ended_at`.

`rule_evaluation`, `comment_classification` and `policy_evaluation` each have
`review_mode boolean` (default `false`): whether review mode applied when the
evaluation ran. `rule_evaluation.also_matched_rule_ids uuid[]` lists the other
rules that matched beside the winner (at most 50).

`action_suggestion` is what automation would have done to one comment. Status is
`pending`, `approved`, `dismissed`, `expired`, `not_applicable` or `withdrawn`;
`decided_at` is set exactly when the status is not `pending`. At most one
suggestion per comment is `pending`. `request_key` makes approve/dismiss
idempotent and is only allowed on `approved` or `dismissed` rows. A trigger
rejects a comment that belongs to a different connection than the suggestion.

`action_suggestion_source` has one row per rule, classifier verdict or policy
that proposed the suggestion. A source proposes at most once per brand, unique
per `(organization_id, brand_id, source_type, source_ref)`, so a redelivered
evaluation cannot reopen a decided suggestion. It holds the proposed `steps` (1
to 5), the `reason`, and for rule sources the `rule_id` and `also_matched_rule_ids` (at most 50).

`action_run` is now either a rule run (`rule_id` and `rule_evaluation_id` set) or
an approval run (`suggestion_id` set, `rule_id` and `rule_evaluation_id` NULL).
`approved_by_user_id` is only allowed on approval runs. There is at most one
approval run per suggestion, and its `comment_id` must equal the suggestion's.

Rolling back this migration deletes all suggestions and approval runs.

### Hidden today

`brand.timezone` is an IANA zone name (`text`, default `UTC`). `brand_timezone_check`
allows 1 to 64 characters shaped like `UTC` or `Area/Name`; Postgres still has to accept
the name in `date_trunc`, so the API also checks `pg_timezone_names`.
`brand.timezone_set_at` is NULL until someone chooses a zone, which means the brand is
still on the default.

"Today" for a brand starts at `date_trunc('day', now, brand.timezone)`.

`moderation_action_applied_hide_idx` on `(organization_id, brand_id, completed_at DESC, id DESC)`
covers only `kind = 'hide' AND status = 'applied'` rows, so the list of hidden comments of a
brand reads newest first without scanning other actions.

`comment_visible_organization_id_posted_at_idx` on `(organization_id, posted_at DESC, id DESC)`
covers only `platform_state = 'visible' AND NOT is_own_account` comments, so the
organization-wide list of visible comments reads newest first.

### Inbox triage

Done and tags exist only in FeedBouncer. Nothing is sent to Facebook or Instagram when a
comment is marked done or tagged.

Tags belong to the workspace, so one tag can be used on comments of every brand.
`comment_tag` and `comment_done` carry `organization_id` and `brand_id`, and their foreign
keys include both, so a comment cannot be linked to a tag of another organization. Deleting a
comment, a tag or a brand removes the matching rows; deleting a user keeps them and clears the
actor column.

`comment_tag`, `comment_done` and `role_grant` rows are inserted or deleted, never edited, so
they keep a single event timestamp (`added_at`, `done_at`, `created_at`) and have no
`updated_at` trigger.

`role_grant_grantable_check` allows only the `member` role and the `comment.reply`
capability. Rolling back the migration deletes all tags, done marks and grants.

### Latest decision per comment

Decisions are never updated. "Restore" is a new `approve` decision. The current
state of a comment is its newest decision:

```sql
SELECT * FROM decision
WHERE comment_id = $1 AND brand_id = $2
ORDER BY sequence DESC
LIMIT 1;
```

`decision_comment_id_sequence_idx` serves this query. `sequence` (also on
`audit_event`) is an internal identity column used only for tie-free ordering.
Never expose it in an API. It reflects allocation order, not commit order, so two
concurrent transactions can commit in the opposite order.

### audit_event contract

- `action` is `<subject>.<verb>`, lowercase with underscores, for example
  `brand.created` (at most 100 characters; the database enforces the format).
- `subject_type` is lowercase with underscores (at most 50 characters).
- `details` is a JSON object of at most 64 KiB (checked by the database).
- `details` must never contain credentials or comment bodies. Store IDs and
  small facts, not content.

### Last owner

Every organization must keep at least one `owner` membership. A deferred
constraint trigger on `membership` (`membership_require_owner_trg`, function
`fb_require_org_owner`) enforces this at COMMIT, so one transaction can add a new
owner and demote the old one in any order.

For each changed membership row (role or organization change, or delete) the
trigger first takes a `FOR NO KEY UPDATE` lock on the `organization` row, then
checks that an owner remains. Because the lock is taken at commit, before the
check, concurrent demotions are serialized by the database and the second one
sees the first one's result: they are safe without any locking in application
code. If the organization row is gone (deleted in the same or another
transaction) the check passes, so deleting an organization works. Deleting a user
who is the sole owner fails with SQLSTATE `23514` and constraint
`membership_owner_required` (`isOwnerRequiredViolation`).

Deadlocks: the trigger locks one organization per changed membership row, so
transactions that change owner memberships in several organizations in different
orders can deadlock. Postgres aborts one of them with SQLSTATE `40P01`; callers
should retry the transaction or surface the error. The same applies to a cascade:
deleting an `app_user` deletes (and row-locks) its memberships first and only
then, at commit, locks their organizations, the reverse of an application
transaction that locks the organization and then changes a membership. Lock the
affected organizations first, in id order, in the same transaction (the API's
account deletion does this).

### Emails and brand names

Emails are stored lowercase (`app_user_email_lower_check`). The migration
lowercases existing rows, and `down.sql` does not reverse that, because it is
lossless for the application.

Brands are archived rather than deleted: `brand.archived_at` is set when a brand
is archived. Brand names are unique per organization among active brands
(`archived_at IS NULL`), compared case-insensitively after trimming whitespace
(`lower(btrim(name))`), so an archived brand's name can be reused.

### Job ledger

`job_ledger` holds one row per logical platform job (`@feedbouncer/jobs`). Redis
only carries the row's id; the row is the source of truth for idempotency
(unique per `(organization_id, idempotency_key)`), retry counters, the worker
lease and the effect record.

`state` values:

- `queued`: waiting for, or being worked by, a worker. A lease
  (`lease_owner`, `lease_expires_at`) is set while a worker holds it.
- `completed`: the job's effect is done and recorded in `result`.
- `dead_lettered`: gave up, with `dead_letter_reason` and `dead_lettered_at`
  set. Listed in the dead-letter queue.
- `resolved`: a dead-lettered job that an operator handled (`resolution` set).

`queued` rows are never purged by retention (`expires_at` only applies to the
other states), so a stuck job stays visible. `payload` may hold comment text but
never credentials; the application layer enforces that.

## Deletion behavior

Every foreign key states its `ON DELETE` action. These are the actions as built:

| Parent deleted   | Child                                                             | Action                                  |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `organization`   | `membership`, `brand`                                             | CASCADE                                 |
| `app_user`       | `membership`                                                      | CASCADE                                 |
| `app_user`       | `auth_session`, `auth_account`                                    | CASCADE                                 |
| `organization`   | `invitation`                                                      | CASCADE                                 |
| `app_user`       | `invitation.invited_by_user_id`, `invitation.accepted_by_user_id` | SET NULL                                |
| `brand`          | `connection`                                                      | CASCADE                                 |
| `connection`     | `source`, `author`                                                | CASCADE                                 |
| `connection`     | `connection_secret`                                               | CASCADE                                 |
| `connection`     | `job_ledger`                                                      | CASCADE                                 |
| `source`         | `comment`                                                         | CASCADE                                 |
| `author`         | `comment.author_id`                                               | SET NULL                                |
| parent `comment` | `comment.parent_comment_id`                                       | SET NULL (`parent_external_id` is kept) |
| `brand`          | `rule`, `decision`                                                | CASCADE                                 |
| `comment`        | `decision`                                                        | CASCADE                                 |
| `rule`           | `decision`                                                        | NO ACTION, deferred (checked at commit) |
| `app_user`       | `decision.actor_user_id`                                          | SET NULL                                |
| `organization`   | `audit_event`                                                     | CASCADE                                 |
| `brand`          | `audit_event.brand_id`                                            | SET NULL                                |
| `app_user`       | `audit_event.actor_user_id`                                       | SET NULL                                |

In practice:

- Deleting an organization removes everything under it, including decisions,
  rules and audit events. Deleting a brand removes its connections, content,
  rules and decisions, but its audit events stay with `brand_id = NULL`.
- Rules cited by decisions cannot be deleted directly. The check is deferred so
  a brand or organization delete can remove rules and decisions together. Retire
  a rule with `enabled = false`.
- Decisions and audit events are append-only. A direct `UPDATE`, `DELETE` or
  `TRUNCATE` is refused by trigger. They disappear only when their organization,
  brand or comment is deleted (audit events: only with their organization).
  The foreign-key actions above are allowed because they run at trigger depth 2.

## Erasure requests

- **Author:** anonymize in place (`display_name = NULL`,
  `external_id = 'erased:' || id`, `anonymized_at = now()`) or delete the row
  (`comment.author_id` becomes NULL).
- **User:** delete the `app_user` row. Memberships go; decisions and audit events
  stay with `actor_user_id = NULL`.
- **Comment:** delete the row. Its decisions go with it; replies keep
  `parent_external_id`.
- Normalizers must strip NUL bytes (`\u0000`) from text before writing. Postgres
  rejects them with SQLSTATE `22021` rather than truncating.

## Security notes

- Credential-like columns are limited to a reviewed allowlist in
  `conventions.integration.test.ts`: `auth_account.password_hash` (scrypt hash),
  `auth_session.token` (SHA-256 digest of the session token) and
  `invitation.token_hash` (SHA-256 of a random token). The guard rejects any
  other column named like `token`, `secret`, `password` or `api_key`.
  `connection_secret.encrypted_value` (envelope v1 ciphertext; the
  `connection_secret_envelope_check` constraint rejects anything else) is exempt
  as an `encrypted_*` `bytea` column.
- Bearer tokens are stored only as SHA-256 digests; the raw token exists only in
  the cookie or email link. `auth_session.token` holds the digest of the session
  token (the API wraps Better Auth's database adapter), and
  `auth_verification.identifier` holds the digest of identifiers such as
  `reset-password:<token>` (Better Auth's `storeIdentifier: 'hashed'`).
  `auth_verification.value` holds no secret (for a password reset, the user id).
  Email verification links carry a signed token that is not stored.
  The API's auth contract test (`apps/api/src/auth/auth-contract.integration.test.ts`)
  enforces this. Anything new written to these columns must follow the same rule.
- Never run the Better Auth CLI against this database. It would generate its own
  schema; the `auth_*` tables are maintained by hand-written migrations.
- `audit_event.details` must not hold secrets or comment bodies (see the contract
  above).
- Every query must filter by `organization_id` (and `brand_id`) taken from the
  authenticated context. Composite foreign keys stop cross-tenant writes, not
  cross-tenant reads.
- `decision.actor_user_id` and `audit_event.actor_user_id` are plain foreign keys
  to `app_user`, not tenant-scoped. The service layer must check that the actor
  is a member of the organization before writing.
- The append-only triggers do not stop a superuser, the table owner (who can
  disable triggers) or a session with `session_replication_role = replica`. When
  application roles are introduced, `REVOKE UPDATE, DELETE, TRUNCATE` on
  `decision` and `audit_event` from them.
- The `fb_*` trigger functions pin `search_path` to `pg_catalog, pg_temp` and
  qualify `pg_trigger_depth()` and `now()`, so a same-named function created in
  another schema cannot shadow them and defeat the append-only guard.
