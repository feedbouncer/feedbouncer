# Subject requests: export and erasure

How to export or erase everything FeedBouncer holds about one person (the
author of comments) inside one organization. Every request covers exactly one
organization. To delete a whole organization see
[data-deletion.md](data-deletion.md); for time-based deletion see
[data-retention.md](data-retention.md).

## Who may run requests

- Organization owners and admins, through the API (`privacy.read`,
  `privacy.export`, `privacy.erase`). Members get 403, and the denial is
  written to the audit log as `privacy.access_denied`.
- The operator, with the CLI: `pnpm ops privacy ...`, which needs `--org <uuid>`
  and `--as <label>` (your name, recorded as the actor). There is no all-organizations mode.

Requests run in the worker. The CLI creates the request and processes it in the
same process, so it needs the database and keys but not Redis.

## Identifiers

An identifier is a platform plus an `externalId` (the platform's id for the
account) or a `handle`, optionally narrowed with `connectionId`. A request
carries 1 to 20 identifiers.

- `externalId` is matched exactly against authors and rule entries.
- `handle` matches rule entries only.
- Display names are never used for matching, and FeedBouncer does not link
  identities: if a person has several accounts, give every id.

The comments list shows display names, not external ids. Get the id from the
requester, from the platform, or from the author entries in a rule
(`id:<externalId>`). A wrong id finds nothing (`found: false`); it never
matches a similar one.

To keep identifiers out of shell history use a file:

```
pnpm ops privacy export --org <uuid> --as alice --subjects-file ./subject.json
```

where the file is a JSON array such as
`[{"platform":"facebook","externalId":"123"}]`. Flags work too:
`--platform facebook --external-id 123 [--handle name] [--connection <uuid>]`;
repeat `--external-id` or `--handle` for more than one. `--reference <ref>`
(letters, digits and `. _ : / -`, up to 64) stores a ticket number. It is the
only free text kept on a request apart from the rule-entry reason.

## Export

API: `POST /api/v1/orgs/:orgId/privacy/requests` with
`{ "kind": "export", "subjects": [...] }` returns 202 and an id. Poll
`GET .../privacy/requests/:id` until `status` is `done`, then download
`GET .../privacy/requests/:id/export`. CLI: `pnpm ops privacy export ...`
prints the counts and the file path; `pnpm ops privacy status --org <uuid> --id <uuid>`
shows a request later.

The archive is `feedbouncer-export-<requestId>.zip`, written by the worker to
`PRIVACY_EXPORT_DIR` as `<requestId>.zip` with mode `0600`. It is a consistent
snapshot, UTF-8 JSON, with these members:

| Member                    | Records                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `manifest.json`           | format, version, request id, organization, time, coverage, the identifiers, counts, `notIncluded` |
| `authors.json`            | platform, connection, external id, display name, first seen                                       |
| `comments.json`           | the person's own comments with text, times, platform state and `inReplyTo`                        |
| `decisions.json`          | decisions on those comments, classifier scores, policy outcomes                                   |
| `review_items.json`       | status, resolution, source, times                                                                 |
| `moderation_actions.json` | kind, status, reply text, times                                                                   |
| `policy_previews.json`    | verdict, proposed action, reason                                                                  |
| `rule_entries.json`       | rules whose lists contain the person, and whether the id or the handle matched                    |
| `operational.json`        | finished jobs that refer to the person's comments (type, state, time)                             |

**Isolation:** rows are selected only through the person's own author rows and
comments. Replies by other people, and the parent of the person's own replies,
are never included; a reply only says `inReplyTo: { commentId, removed }`.
Other organizations are not read.

The file stays for `PRIVACY_EXPORT_TTL_HOURS` (1 to 720, default 72). Then the
worker deletes it and the request can no longer be downloaded. The API serves
downloads from `PRIVACY_EXPORT_DIR`, mounted read-only; give both services the
same directory (`compose.yaml` does). Deliver the file through a secure
channel and do not keep copies: it holds personal data.

## Erasure

Run a dry run first, then execute.

```
pnpm ops privacy erase --org <uuid> --as alice --subjects-file ./subject.json --dry-run
pnpm ops privacy erase --org <uuid> --as alice --subjects-file ./subject.json
```

Through the API the same is `kind: "erasure"` with `dryRun: true` or `false`.
A dry run counts exactly what execute would delete and writes nothing.

Erasure deletes, in the organization:

- the person's comments and author rows, with their decisions, evaluations,
  review items, action suggestions, previews and moderation records;
- the person's entries in rule author lists (see below);
- the person's identifiers from rule-change proposals (replaced with
  `[erased]`; pending proposals become stale) and from audit event details;
- cached API responses and finished job records that refer to their comments.

It does not contact the platform. Aggregate counters hold no identifier and
are unchanged.

**Replies:** replies by other people stay, with the parent marked removed
(shown as "Reply to a removed comment"). The person's own replies to others are
deleted; the other person's comment is untouched.

**Review queue:** open review items and pending suggestions on the person's
comments are cancelled and removed.

**Rule entries:** matching entries are removed by default, which creates a new
rule revision. If that leaves an author condition empty the rule is disabled.
To keep the entries (for example to keep blocking someone), pass
`keepRuleEntries: { "reason": "..." }` or `--keep-rule-entries "<reason>"`. The
reason is stored in the audit record, so do not put personal data in it.

**Coverage:** every result says `coverage: all_ingested_before_completed_at`.
Erasure loops until a pass finds no comments, then deletes the author rows.
Comments ingested before the request completes are erased; one ingested after
`completedAt` is new data and is not covered. Erased comments are fingerprinted,
so polls and webhook retries do not ingest them again, and the API never
re-sends them.

Running the same erasure again is safe: nothing is left, so it returns
`found: false` and zero counts. An identifier that matches nothing gives the
same answer, not an error.

## Audit records

Each request writes `privacy.export_requested` or `privacy.erasure_requested`,
and on completion `privacy.export_completed`, `privacy.erasure_dry_run_completed`
or `privacy.erasure_completed`; failures write `privacy.request_failed`,
downloads `privacy.export_downloaded`. Details hold only `requestId`, `mode`,
`subjectCount`, `found`, `counts`, `coverage`, `reference`,
`keepRuleEntriesReason` and `durationMs`. They never hold an identifier,
handle, display name, comment text or file path. The identifiers of a pending
request are stored encrypted and cleared when it finishes. Audit records are
themselves deleted after `RETENTION_AUDIT_DAYS`.

## What is not covered

- Data held by the source platform (Facebook, Instagram and others) or by AI
  providers that received comment text.
- Other identities of the person that you did not give as identifiers.
- Backups and replicas you manage ([data-retention.md](data-retention.md#backups-and-replicas))
  and your own log pipeline.
- Comments by other people that quote or name the person. Only the person's
  own records are matched.

## Responsibility

FeedBouncer provides these mechanisms; you remain responsible for meeting your own legal obligations. This document is not legal advice.

## Hosted and self-hosted

Behaviour is identical. Nothing in the code checks which one you run.
