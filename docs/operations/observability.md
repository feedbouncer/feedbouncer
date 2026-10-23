# Observability

FeedBouncer's API and worker emit structured logs, optional distributed traces and
Prometheus metrics, and derive a health state for every platform connection. This guide
covers how to enable each signal, what every field and metric means, and what to do when
a connection is unhealthy. Nothing here needs a collector: logs go to stdout, trace export
is off by default and the metrics listeners bind to loopback unless you change them.

## Overview

| Question                                                 | Signal                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| What happened to this request, webhook or job?           | [Logs](#logs) filtered by `trace_id`, `job_id` or `request_id`; [traces](#traces) if enabled |
| Is this connection healthy, and if not, why?             | [Connector health](#connector-health): API endpoint, or the `feedbouncer_connector_*` gauges |
| Is the system keeping up (queues, retries, API latency)? | [Metrics](#metrics): `feedbouncer_queue_*`, `feedbouncer_jobs_total`, `feedbouncer_http_*`   |

Defaults: logs always on (JSON on stdout), traces `none`, metrics served on `127.0.0.1`
only. A bare `docker compose up` needs no extra configuration.

## Logs

Every log line is one JSON object on stdout. Pre-logger configuration errors are also one
JSON line, on stderr. The operator command-line tools (`pnpm jobs ...`, `pnpm secrets ...`)
keep human-readable output.

### Core keys

| Key       | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `time`    | The timestamp, ISO-8601 in UTC with milliseconds.                      |
| `level`   | `debug`, `info`, `warn` or `error`.                                    |
| `service` | `api` or `worker`.                                                     |
| `msg`     | The message: a short event name (`job.completed`) or a short sentence. |

Callers cannot override these four keys. Other fields are additive: older camelCase
fields such as `platform`, `jobType`, `ledgerId`, `organizationId` and `connectionId` are
still present on the lines that already carried them.

### Correlation keys

Correlation keys are snake_case and are attached automatically to every line written while
the work is in scope. A value that is not a safe identifier is dropped, never logged.

| Key              | Present when                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `tenant_id`      | An authenticated API request or a job is in scope (the organization id).                                |
| `brand_id`       | A job is running (the brand the job belongs to).                                                        |
| `connector_id`   | A connection is known: its id, taken from a verified webhook delivery or a job.                         |
| `connector_type` | The platform (`facebook`, `instagram`, `youtube`, ...); `unknown` for a webhook to an unknown platform. |
| `job_id`         | A job is running or being enqueued: the `job_ledger` row id.                                            |
| `request_id`     | An API request is in scope.                                                                             |
| `trace_id`       | A span is active (32 hex characters).                                                                   |
| `span_id`        | A span is active (16 hex characters).                                                                   |

Unauthenticated or rejected webhooks never carry `connector_id`: the id a caller sends is
not trusted until the signature has been verified.

### Error keys

Errors are logged as `error` (the class name), `errorCode` (the stable code, for example
`rate_limited`), `errorClass` and `errorMessage` (with secrets masked). `errorClass` is one
of `retryable`, `rate_limited`, `non_retryable`, `needs_reconnection` or `null`.

### Configuration

| Variable    | Default | Meaning                                                                                  |
| ----------- | ------- | ---------------------------------------------------------------------------------------- |
| `LOG_LEVEL` | `info`  | `debug`, `info`, `warn` or `error`. An invalid value fails startup with a clear message. |

### Recipes

```bash
# Everything that happened to one job
docker compose logs worker --no-log-prefix | jq -c 'select(.job_id == "<ledger id>")'

# One trace across the API and the worker
docker compose logs api worker --no-log-prefix | jq -c 'select(.trace_id == "<trace id>")'

# One connection, without debug noise
docker compose logs worker --no-log-prefix | jq -c 'select(.connector_id == "<connection id>" and .level != "debug")'
```

### Notable events

| `msg`                                                    | Level      | Meaning                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job.enqueued`, `job.deduplicated`, `job.completed`      | info       | Job lifecycle. See [job-queue.md](job-queue.md#observability).                                                                                                                                                            |
| `job.retried`, `job.deferred`                            | warn       | An attempt failed and will be retried, or the job was pushed back.                                                                                                                                                        |
| `job.dead_lettered`                                      | error      | The job reached the dead-letter queue (adds `reason`, `code`).                                                                                                                                                            |
| `job.replayed`, `job.requeued`, `job.duplicate_delivery` | info       | Operator replay, sweeper re-add, or a queue redelivery that was skipped.                                                                                                                                                  |
| `job.trace_started`                                      | debug      | The job row had no valid trace context, so a new trace was started.                                                                                                                                                       |
| `job.lost_lease`, `job.missing`, `job.invalid_data`      | warn/error | A job could not be run as delivered.                                                                                                                                                                                      |
| `moderation.resync_not_queued`                           | warn       | A moderation action finished but the follow-up re-read of the comment could not be queued (adds `actionId`). The outcome is recorded; the stored comment catches up on its next event or action.                          |
| `webhook.unrouted_events`                                | info       | A verified webhook delivery named accounts with no live connection; those events were dropped (adds `platform`, `count`). Expected after a disconnect; a sustained count for a connected account means a routing problem. |
| `duplicate webhook delivery skipped`                     | info       | A redelivered webhook was recognized and not processed again.                                                                                                                                                             |
| `webhook rejected`                                       | warn       | A delivery failed verification (adds `check`, never the payload).                                                                                                                                                         |
| `token refresh joined`, `token refresh reused`           | info       | A concurrent refresh was shared in-process or across processes.                                                                                                                                                           |
| `access token refreshed`, `token refresh failed`         | info/warn  | A token refresh finished.                                                                                                                                                                                                 |
| `telemetry.*`                                            | varies     | The telemetry layer itself, for example `telemetry.metrics_ready`, `telemetry.tracing_ready`, `telemetry.collect_failed`, `telemetry.exporter_problem`, `telemetry.shutdown_timeout`.                                     |

Ad moderation adds these events:

| `msg`                      | Level | Meaning                                                                                                                   |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `ads.discovery_partial`    | info  | An ad listing stopped at the call budget (adds `listed`); the next discovery job resumes from the saved cursor.           |
| `ads.unresolved`           | info  | Ads whose Page or Instagram post could not be resolved, per `reason` and `count`.                                         |
| `ads.poll_defer_failed`    | warn  | A throttled or failing poll could not push back its untried sources (adds `sources`).                                     |
| `scheduler.enqueue_failed` | warn  | The scheduler could not enqueue a job (adds `jobType`, `platform`; never ids or payload). It is retried on the next tick. |
| `scheduler.query_failed`   | warn  | The scheduler could not read connections or due sources; the tick is skipped.                                             |

Ad comments that polling creates feed the same ingest-lag metric as webhook
comments (`platform="facebook"` or `"instagram"`). Their lag is measured from
the comment's own time, so it is bounded below by the poll interval. Expect
roughly one `ad_poll` ledger row per connection with due ad sources per poll
interval, and one `ad_discovery` row per ad account per discovery interval.

The Instagram connector reports through the same metrics as the others: its
series carry `platform="instagram"` (and `connector_type` `instagram` in logs
and health), so filter by that label to separate it from `facebook`.

The worker's periodic sweep also logs `job.stats` with the requeued and purged counts and per-platform event counters.

## Traces

### Enabling

Tracing is off by default. To export spans over OTLP/HTTP:

```bash
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.internal:4318
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <token>   # secret
```

| Variable                        | Default                                  | Meaning                                                                                                                                                     |
| ------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_TRACES_EXPORTER`          | `none`                                   | `none` or `otlp`. The default is `none`, a deliberate deviation from the OpenTelemetry default: with `none` no exporter is constructed and nothing is sent. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | unset                                    | OTLP/HTTP collector base URL. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is also honored.                                                                         |
| `OTEL_EXPORTER_OTLP_HEADERS`    | unset                                    | Comma-separated `key=value` headers for the exporter. Put credentials here, never in the URL.                                                               |
| `OTEL_SERVICE_NAME`             | `feedbouncer-api` / `feedbouncer-worker` | Starts with a lowercase letter, then lowercase letters, digits and `-`; up to 64 characters.                                                                |
| `OTEL_SDK_DISABLED`             | `false`                                  | `true` forces the exporter off regardless of `OTEL_TRACES_EXPORTER`.                                                                                        |
| `TELEMETRY_SHUTDOWN_TIMEOUT_MS` | `5000`                                   | 100 to 30000. Bounds exporter timeouts and the flush on shutdown.                                                                                           |

The SDK also reads the standard `OTEL_BSP_*` batch settings. A URL with credentials in it
(`https://user:pass@collector`) is rejected at startup, and the error does not echo the
password. `OTEL_EXPORTER_OTLP_HEADERS` is secret: keep it in a secret store or a mounted
file, not in a committed file. It is never logged and never part of the redacted
configuration summary.

### Span catalogue

| Span                    | Kind     | Where                       | Notes                                                                                                            |
| ----------------------- | -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `webhook.receive`       | server   | Webhook gate (intake)       | A new root for every delivery. `feedbouncer.webhook.outcome`: `accepted`, `duplicate`, `rejected`.               |
| `job.enqueue`           | producer | Job producer                | Child of the active span; records `feedbouncer.job.deduplicated`.                                                |
| `job.run`               | consumer | Job runner, one per attempt | `feedbouncer.job.attempt` is 1 for the first try. Retries are sibling spans in one trace.                        |
| `connector.<operation>` | client   | Platform calls              | `<operation>` is `list_sources`, `list_recent_sources`, `list_comments`, `list_replies`, `get_comment` or `act`. |
| `moderation.apply`      | internal | `ConnectionClient.act`      | Carries `feedbouncer.action` and `feedbouncer.action.status`.                                                    |
| `HTTP <method> <route>` | server   | API requests                | A new root per request; `<route>` is the route pattern, never the raw path.                                      |

Failed spans carry `feedbouncer.error.code` and `feedbouncer.error.class`, and the span
status message is the code. Exceptions are never recorded on spans, so error messages and
stack traces never reach the collector.

### Propagation

A trace crosses the queue through the `job_ledger.trace_context` column, written by our
own producer when a job is enqueued. The runner continues from it, so the intake, every
attempt and the moderation outcome share one `trace_id`. Sweeper re-adds and operator
replays keep the original trace. A row with no or an invalid trace context (older rows,
rolling deploys) starts a fresh trace and logs `job.trace_started` at debug.

Trace context is never accepted from inbound HTTP headers. A `traceparent` header on a
webhook or API request is ignored, so an outside caller cannot inject itself into your
traces or force a trace id.

### Attributes

Span attributes are restricted to an allowlist of identifiers and categories
(`feedbouncer.*`, `http.*`, `messaging.*`). Secret-like keys are dropped, string values are
redacted and cut at 256 characters. Comment text, tokens and payloads are never attributes.

### Not yet wired

There is no webhook intake route and no poll job in the application yet, and the
moderation rules engine does not exist. The instrumentation sits in the framework choke
points those features will call: `WebhookGate.handle` is the intake root span, a poll
job's `job.run` is its root, and `ConnectionClient.act` emits `moderation.apply`. When the
rules engine lands it must wrap each decision in `withSpan('moderation.decide', ...)`
so the decision appears between the job and the action.

## Metrics

### Endpoints

| Process | Default address          | Serves                                                                                                                        |
| ------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| API     | `127.0.0.1:9464/metrics` | HTTP request metrics, webhook metrics (once the intake route lands), default process metrics.                                 |
| Worker  | `127.0.0.1:9465/metrics` | Job counters, queue wait, connector-call metrics, the per-connection health gauges and queue gauges, default process metrics. |

| Variable                  | Default                       | Meaning                                                                     |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `METRICS_HOST`            | `127.0.0.1`                   | Interface the listener binds to.                                            |
| `METRICS_PORT`            | `9464` (api), `9465` (worker) | `0` disables the listener.                                                  |
| `METRICS_MAX_CONNECTIONS` | `1000`                        | 1 to 100000. Cap on per-connection series; see [cardinality](#cardinality). |

`/metrics` has no authentication. Loopback is the default for that reason. To scrape from
another container you must set `METRICS_HOST` deliberately (the compose file sets
`0.0.0.0` for the api and worker containers, and publishes neither port to the host).
Anyone who can reach the port can read it, so keep it on a private network and do not
publish it. A `compose.override.yaml` that adds `ports:` for 9464 or 9465 publishes an
unauthenticated endpoint, so do not do that outside a throwaway machine. The listener only answers `GET` and `HEAD` on `/metrics`. A port conflict is
logged as `telemetry.metrics_server_failed` and the process keeps running without metrics.

`compose.yaml` forwards only `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT` and
`METRICS_HOST`. `METRICS_PORT`, `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`,
`OTEL_EXPORTER_OTLP_HEADERS`, `METRICS_MAX_CONNECTIONS`, `TELEMETRY_SHUTDOWN_TIMEOUT_MS` and
the `CONNECTOR_*` thresholds are not passed through: set them in a `compose.override.yaml`
(under `environment:` of `api` and `worker`) when running with compose.

Default process metrics (`process_*`, `nodejs_*`) come from the Prometheus client and
carry a `service` label (`api` or `worker`).

### Reference

| Metric                                                 | Type      | Labels                                    | Served by | Meaning                                                                                                                                                 |
| ------------------------------------------------------ | --------- | ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedbouncer_jobs_total`                               | counter   | `queue`, `job_type`, `outcome`            | worker    | Job events. `outcome` is `enqueued`, `deduplicated`, `completed`, `retried`, `deferred`, `dead_lettered`, `replayed`, `duplicate_delivery`, `requeued`. |
| `feedbouncer_queue_wait_seconds`                       | histogram | `queue`                                   | worker    | Time between a job becoming due and a worker claiming it.                                                                                               |
| `feedbouncer_queue_depth`                              | gauge     | `queue`                                   | worker    | Queued (not yet completed) jobs per queue, counted from the ledger.                                                                                     |
| `feedbouncer_queue_oldest_age_seconds`                 | gauge     | `queue`                                   | worker    | Age of the oldest queued job per queue.                                                                                                                 |
| `feedbouncer_connector_api_calls_total`                | counter   | `platform`, `operation`, `outcome`        | worker    | Platform API calls. `outcome` is `ok` or the error kind: `auth_expired`, `rate_limited`, `not_found`, `unsupported`, `transient`, `permanent`.          |
| `feedbouncer_connector_api_call_duration_seconds`      | histogram | `platform`, `operation`                   | worker    | Platform call latency, including the single token-refresh retry.                                                                                        |
| `feedbouncer_webhook_deliveries_total`                 | counter   | `platform`, `outcome`                     | api       | Webhook deliveries: `accepted`, `duplicate`, `rejected`. An unknown platform is `unknown`.                                                              |
| `feedbouncer_webhook_events_total`                     | counter   | `platform`                                | api       | Events in accepted (non-duplicate) deliveries.                                                                                                          |
| `feedbouncer_webhook_event_delay_seconds`              | histogram | `platform`                                | api       | Platform event time to our receipt. Negative skew is clamped to 0.                                                                                      |
| `feedbouncer_comment_ingest_lag_seconds`               | histogram | `platform`, `outcome`                     | worker    | Platform event time to comment ingested, by ingest outcome (created, updated, stale, deleted, gone). Negative skew is clamped to 0.                     |
| `feedbouncer_http_requests_total`                      | counter   | `method`, `route`, `status_class`         | api       | API requests by route pattern and status class (`2xx`, `4xx`, ...). Unmatched paths are `route="unmatched"`.                                            |
| `feedbouncer_http_request_duration_seconds`            | histogram | `method`, `route`                         | api       | API request duration.                                                                                                                                   |
| `feedbouncer_connector_health_status`                  | gauge     | `connection_id`, `platform`, `status`     | worker    | `1` for the connection's current state, `0` for the other four.                                                                                         |
| `feedbouncer_connector_last_success_timestamp_seconds` | gauge     | `connection_id`, `platform`               | worker    | Unix time of the last successful sync. Absent before the first sync.                                                                                    |
| `feedbouncer_connector_sync_staleness_seconds`         | gauge     | `connection_id`, `platform`               | worker    | Seconds since the last successful sync. Absent while pending first sync.                                                                                |
| `feedbouncer_connector_ingest_lag_seconds`             | gauge     | `connection_id`, `platform`               | worker    | Age of the oldest queued job for the connection; `0` when none.                                                                                         |
| `feedbouncer_connector_consecutive_failures`           | gauge     | `connection_id`, `platform`               | worker    | Platform call failures since the last success.                                                                                                          |
| `feedbouncer_connector_last_error_info`                | gauge     | `connection_id`, `platform`, `error_code` | worker    | Last error code seen for the connection (value always `1`). Absent when none.                                                                           |
| `feedbouncer_connector_series_truncated`               | gauge     | none                                      | worker    | `1` when more connections exist than `METRICS_MAX_CONNECTIONS`.                                                                                         |
| `feedbouncer_telemetry_collect_errors_total`           | counter   | `collector`                               | worker    | Scrape-time collectors that failed (`connector_health`, `queues`); their gauges are omitted.                                                            |
| `feedbouncer_telemetry_negative_lag_total`             | counter   | `source`                                  | api       | Lag samples clamped because the source timestamp was ahead of our clock (`webhook_event`).                                                              |
| `feedbouncer_scan_finished_total`                      | counter   | `status`, `reason`                        | worker    | Free scans finished. `status` is `completed` or `failed`; `reason` is the failure reason, or `none`.                                                    |
| `feedbouncer_scan_duration_seconds`                    | histogram | none                                      | worker    | Free scan run time, from claim to the stored result or failure.                                                                                         |
| `feedbouncer_scan_comments_scanned`                    | histogram | none                                      | worker    | Visible comments counted by a completed free scan.                                                                                                      |
| `feedbouncer_scan_authorize_total`                     | counter   | none                                      | api       | Free scan visitors sent to the Facebook dialog.                                                                                                         |
| `feedbouncer_scan_created_total`                       | counter   | none                                      | api       | Free scans queued.                                                                                                                                      |
| `feedbouncer_scan_cta_clicks_total`                    | counter   | none                                      | api       | Sign-up links followed from a free scan result.                                                                                                         |

Histogram buckets: call and request durations use 0.01 s to 30 s; queue wait and event
delay use 0.1 s to 6 h.

### Cardinality

Allowed label names are `platform`, `queue`, `job_type`, `operation`, `outcome`, `status`,
`error_code`, `method`, `route`, `status_class`, `collector`, `source`,
`service`, `connection_id` and `reason` (a closed set of free scan failure reasons).

- `connection_id` appears only on the per-connection gauges. They are capped at
  `METRICS_MAX_CONNECTIONS` connections (selected in id order), and
  `feedbouncer_connector_series_truncated` becomes `1` when the cap cuts anything off.
- Tenant, brand, comment and job ids are never labels.
- A platform taken from an untrusted request is labelled `unknown` unless it is a
  registered platform, so a hostile path cannot create new series.
- Connector-call metrics are labelled by platform, not by connection, to bound series.
  Per-connection error state is in `last_error_info` and `consecutive_failures`.

### Reading the job metrics

| You want            | Query                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| Jobs that succeeded | `outcome="completed"`                                                 |
| Failed attempts     | `outcome="retried"` plus `outcome="dead_lettered"`                    |
| Jobs dead-lettered  | `outcome="dead_lettered"`, counted once when the ledger write commits |

### Restarts and replicas

Counters and histograms reset when a process restarts; use `rate()` and `increase()`. The
health and queue gauges are recomputed from Postgres on each scrape (with a 10 second
cache), so they survive restarts. With several worker replicas every replica serves the
same gauge values: scrape one replica, or aggregate with `max by (connection_id)`. Counters
are per process; sum them.

### Prometheus scrape configuration

```yaml
scrape_configs:
  - job_name: feedbouncer-api
    static_configs:
      - targets: ['api:9464']
  - job_name: feedbouncer-worker
    dns_sd_configs:
      - names: ['worker']
        type: A
        port: 9465
```

The Prometheus container must join the compose network (`feedbouncer_default`).

## Connector health

Each connection has one of five states. The state is derived from the connection row,
its stored token expiry, its recorded sync outcome and the age of its oldest queued job.
Rules are evaluated in order and the first match wins.

| #   | Connection facts                                                                    | State                | Reason                                   |
| --- | ----------------------------------------------------------------------------------- | -------------------- | ---------------------------------------- |
| 1   | Status `paused` or `revoked`                                                        | `disabled`           | `paused` or `revoked`                    |
| 2   | Status `reconnect_required` (this includes `oauth_pending`)                         | `needs_reconnection` | the stored reason                        |
| 3   | An access token exists and has expired, and the refresh token is missing or expired | `needs_reconnection` | `token_expired`                          |
| 4   | Status `error`                                                                      | `degraded`           | the stored reason, or `connection_error` |
| 5   | Never synced and failures at or above `CONNECTOR_FAILURES_DEGRADED`                 | `degraded`           | `recent_failures`                        |
| 6   | Never synced otherwise                                                              | `pending_first_sync` | `pending_first_sync`                     |
| 7   | Consecutive failures at or above `CONNECTOR_FAILURES_DEGRADED`                      | `degraded`           | `recent_failures`                        |
| 8   | Staleness above the stale threshold                                                 | `degraded`           | `sync_stale`                             |
| 9   | Ingest lag above `CONNECTOR_LAG_DEGRADED_SECONDS`                                   | `degraded`           | `ingest_lag`                             |
| 10  | Otherwise                                                                           | `healthy`            | `ok`                                     |

A transient authentication failure (`auth_expired` without a reauthorization requirement)
only increments the failure count, so it shows as `degraded` and not `needs_reconnection`.

### States and recovery

| State                | Meaning                                                | What to do                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `healthy`            | Recent successful sync, no failure streak, no backlog. | Nothing.                                                                                                                                                                                                      |
| `pending_first_sync` | Connected, no successful read or webhook yet.          | Wait. It stays in this state until a sync outcome is recorded; there is no overdue timeout.                                                                                                                   |
| `degraded`           | Working but not keeping up. Check `reason`.            | See the reason table below.                                                                                                                                                                                   |
| `needs_reconnection` | The platform credentials are no longer usable.         | Reconnect from the brand's connections page. Reasons: `oauth_refresh_rejected`, `oauth_access_rejected`, `oauth_not_refreshable`, `setup_not_queued`, `token_expired`, `oauth_pending`, `reconnect_required`. |
| `disabled`           | A user paused or revoked the connection.               | Nothing to fix; resume or reconnect it deliberately.                                                                                                                                                          |

| Degraded reason    | What to check                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_stale`       | Worker logs for the connector: `jq 'select(.connector_id == "<id>")'`. Is the poll running, are calls failing?                           |
| `ingest_lag`       | Queue depth and age (`feedbouncer_queue_depth`, `feedbouncer_queue_oldest_age_seconds`) and the dead-letter queue: `pnpm jobs dlq list`. |
| `recent_failures`  | `lastErrorCode` in the API response; look it up in [Errors](../connectors/writing-a-connector.md#errors).                                |
| `connection_error` | The connection is in an error status without a recorded reason; check worker logs around the last failure.                               |

### API

```
GET /api/v1/orgs/:orgId/brands/:brandId/connections/health
```

Requires a session and the `connection.read` capability, held by organization owners and
admins. The brand must belong to the organization; a missing brand and another
organization's brand both return `404` with the same body. A member gets `403`, no session
`401`.

```json
{
  "connections": [
    {
      "connectionId": "6b0f6e0e-...",
      "platform": "facebook",
      "status": "degraded",
      "reason": "recent_failures",
      "lastSuccessAt": "2026-10-12T08:00:00.000Z",
      "lastErrorCode": "rate_limited",
      "lastErrorAt": "2026-10-12T08:55:12.000Z",
      "consecutiveFailures": 3,
      "stalenessSeconds": 3300,
      "ingestLagSeconds": 0,
      "failedImports": 0
    }
  ]
}
```

`failedImports` counts the connection's comment-ingest jobs dead-lettered in the last 14
days; it never changes `status`.

`reason` is limited to a fixed vocabulary: `ok`, `pending_first_sync`, `recent_failures`,
`sync_stale`, `ingest_lag`, `token_expired`, `paused`, `revoked`,
`connection_error`, `reconnect_required`, `oauth_pending`, `oauth_refresh_rejected`,
`oauth_access_rejected`, `oauth_not_refreshable` and `credential_unavailable` (the stored
credentials could not be read). A stored free-form reason is never echoed. The endpoint
returns codes only, never error messages, and at most 500 connections per brand, ordered
oldest first.

### Thresholds

| Variable                                   | Default         | Range         | Meaning                                                                      |
| ------------------------------------------ | --------------- | ------------- | ---------------------------------------------------------------------------- |
| `CONNECTOR_STALE_AFTER_SECONDS`            | `3600`          | 60 to 2592000 | Time since the last successful sync before `sync_stale`.                     |
| `CONNECTOR_STALE_AFTER_SECONDS_<PLATFORM>` | the value above | 60 to 2592000 | Per-platform override, for example `CONNECTOR_STALE_AFTER_SECONDS_FACEBOOK`. |
| `CONNECTOR_LAG_DEGRADED_SECONDS`           | `900`           | 60 to 604800  | Age of the oldest queued job before `ingest_lag`.                            |
| `CONNECTOR_FAILURES_DEGRADED`              | `3`             | 1 to 100      | Consecutive failures before `recent_failures`.                               |

Out-of-range values fail startup with a message naming the variable.

### What counts as a sync

`last_success_at` is the last successful read from the platform (`list_sources`,
`list_comments`, `get_comment`) or an accepted webhook for that connection. A poll that
returns zero comments still counts, so a quiet account stays `healthy` as long as its
polls succeed. A read that finds a deleted comment or source (the platform answered) is
also a success. Local budget exhaustion is not a failure. Successes are coalesced to at
most one write per connection per 10 seconds.

A connector that only receives webhooks has no poll to refresh it, so a quiet account can
exceed the stale threshold; raise `CONNECTOR_STALE_AFTER_SECONDS_<PLATFORM>` for it until
reconciliation polling exists.

### Known limitations

- Sync outcomes are written to `connection_sync` by `PgSyncRecorder`, which the API and
  worker do not wire in yet: no process polls platforms or accepts attributed webhooks.
  Until they do, every active connection reports `pending_first_sync`, and staleness and
  failure rules never fire. `token_expired`, `disabled` and the stored-reason states still
  work because they come from the connection row.
- The connector-call metrics (`feedbouncer_connector_api_calls_total`,
  `feedbouncer_connector_api_call_duration_seconds`) and webhook metrics
  (`feedbouncer_webhook_*`) are registered but not yet emitted, for the same reason.
- Webhooks verified with an app-level secret cannot be attributed to a connection at the
  gate, so they record no sync. The future per-event ingest job will record them.
- Ingest lag is the age of the oldest `queued` `job_ledger` row for the connection, which
  includes jobs deferred into the future. A long deferral therefore raises lag. Comments
  do not yet have a processed marker, so this is job-level lag.
- API requests rejected by an authentication or tenancy guard (401, 403, 404) are logged
  and counted in the HTTP metrics but have no span.
- Connections that are paused or revoked still count toward `METRICS_MAX_CONNECTIONS`.

## Lag and clock skew

- Staleness and ingest lag are computed with the Postgres clock (`now()`) at both ends, so
  they are not affected by clock differences between hosts.
- `feedbouncer_webhook_event_delay_seconds` uses the platform's `occurredAt` against our
  receipt time, so it includes the platform's clock. A timestamp ahead of ours is clamped
  to 0, counted in `feedbouncer_telemetry_negative_lag_total{source="webhook_event"}` and
  logged once per delivery as a warning (`telemetry.negative_lag`).

## Privacy and security

- Never in telemetry: access and refresh tokens, webhook secrets, authorization headers,
  encryption keys, and comment bodies. Connector error messages are not logged or put on
  spans; only error kinds and codes are.
- Logs mask secret-looking field names and values: bearer tokens, `Authorization` and
  `Proxy-Authorization` headers, and fields named like secrets or tokens. Masking is
  pattern based; do not log credentials on purpose.
- Tenant, brand, comment and job identifiers are never metric labels.
- The metrics endpoints are operator-only and unauthenticated. Keep them on a private
  network, do not publish their ports, and put any Prometheus on the same network.
- The health API is tenant-scoped and limited to owners and admins.
- OTLP credentials belong in `OTEL_EXPORTER_OTLP_HEADERS`, never in the URL.

## Failure behavior

- Telemetry never fails work. An exporter outage, a failing sink or a throwing log write is
  swallowed (and logged once under a `telemetry.*` message where possible); requests and
  jobs are unaffected.
- Shutdown waits at most `TELEMETRY_SHUTDOWN_TIMEOUT_MS` to flush traces.
- A failing scrape collector (for example Postgres is down) drops its gauges, so they are
  absent and not stale. `/metrics` still answers `200` with process and counter metrics,
  and `feedbouncer_telemetry_collect_errors_total{collector}` increases.
- Gauge queries are bounded: a scrape waits at most about 5 seconds for the database.

## Beta status report

`pnpm ops beta-status [--json]` prints one row per connection: health, last successful sync,
comments ingested and evaluated in the last 24 hours (backfilled comments excluded),
`unevaluated`, `failedImports` and `queuedJobs`. `unevaluated` counts live comments ingested
between 10 minutes and 14 days ago, not deleted, that have no rule evaluation; it must be 0.
Output holds ids only, no organization or brand names. The exit code is 2 when any row has
`unevaluated > 0`, `failedImports > 0` or health `needs_reconnection`. Errors exit 1 (or 2 for bad usage), so a daily cron should alert on any
non-zero exit.
