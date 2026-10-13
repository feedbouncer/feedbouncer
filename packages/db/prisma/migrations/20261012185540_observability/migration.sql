-- Observability (docs/operations/observability.md).
-- connection_sync: last known sync outcome per connection, written by the
-- connector runtime and webhook gate, read by connector health. Holds no
-- secrets and no comment content.
-- job_ledger.trace_context: W3C traceparent written by the producer so a trace
-- continues across the queue; NULL means "start a new trace".
BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE connection_sync (
  connection_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  last_success_at timestamptz(3),
  last_failure_at timestamptz(3),
  last_error_code text,
  last_error_class text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT connection_sync_pkey PRIMARY KEY (connection_id),
  CONSTRAINT connection_sync_last_error_code_check CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT connection_sync_last_error_class_check CHECK (last_error_class IS NULL OR last_error_class IN
    ('retryable', 'rate_limited', 'non_retryable', 'needs_reconnection')),
  CONSTRAINT connection_sync_last_error_check CHECK (
    (last_error_code IS NULL) = (last_error_class IS NULL)
    AND (last_error_code IS NULL) = (last_failure_at IS NULL)),
  CONSTRAINT connection_sync_consecutive_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT connection_sync_organization_id_brand_id_connection_id_fkey
    FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE INDEX connection_sync_organization_id_brand_id_idx ON connection_sync (organization_id, brand_id);
CREATE TRIGGER connection_sync_set_updated_at_trg BEFORE UPDATE ON connection_sync
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

ALTER TABLE job_ledger ADD COLUMN trace_context text;
ALTER TABLE job_ledger ADD CONSTRAINT job_ledger_trace_context_check CHECK (
  trace_context IS NULL OR trace_context ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');
-- Ingest lag per connection and queue depth/oldest age per platform.
CREATE INDEX job_ledger_queued_connection_id_created_at_idx ON job_ledger (connection_id, created_at)
  WHERE state = 'queued';
CREATE INDEX job_ledger_queued_platform_created_at_idx ON job_ledger (platform, created_at)
  WHERE state = 'queued';

COMMIT;
