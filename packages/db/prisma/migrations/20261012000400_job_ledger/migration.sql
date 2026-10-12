-- Job queue ledger (packages/jobs): one row per logical platform job. Source of
-- truth for idempotency (unique per organization + key), retry counters, the
-- worker lease, the effect record and the dead-letter queue (state
-- dead_lettered/resolved). Redis only carries {ledgerId}. Payloads may hold
-- comment text but never credentials (enforced in packages/jobs/src/payload.ts).
BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE job_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  platform text NOT NULL,
  job_type text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  failures integer NOT NULL DEFAULT 0,
  crashes integer NOT NULL DEFAULT 0,
  deferrals integer NOT NULL DEFAULT 0,
  deferred_ms bigint NOT NULL DEFAULT 0,
  replays integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz(3),
  next_run_at timestamptz(3),
  last_error_kind text,
  last_error_code text,
  first_failed_at timestamptz(3),
  last_failed_at timestamptz(3),
  dead_letter_reason text,
  dead_lettered_at timestamptz(3),
  resolution text,
  result jsonb,
  completed_at timestamptz(3),
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT job_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT job_ledger_organization_id_idempotency_key_key UNIQUE (organization_id, idempotency_key),
  CONSTRAINT job_ledger_platform_check CHECK (
    platform IN ('facebook', 'instagram', 'tiktok', 'youtube', 'threads', 'linkedin', 'x', 'bluesky')),
  CONSTRAINT job_ledger_job_type_check CHECK (job_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT job_ledger_idempotency_key_check CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT job_ledger_payload_check CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  CONSTRAINT job_ledger_result_check CHECK (
    result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 8192)),
  CONSTRAINT job_ledger_state_check CHECK (state IN ('queued', 'completed', 'dead_lettered', 'resolved')),
  CONSTRAINT job_ledger_counters_check CHECK (
    failures >= 0 AND crashes >= 0 AND deferrals >= 0 AND deferred_ms >= 0 AND replays >= 0),
  CONSTRAINT job_ledger_lease_check CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)
    AND (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 200)),
  CONSTRAINT job_ledger_last_error_kind_check CHECK (last_error_kind IS NULL OR last_error_kind IN
    ('retryable', 'rate_limited', 'non_retryable', 'needs_reconnection', 'stalled', 'invalid')),
  CONSTRAINT job_ledger_last_error_code_check CHECK (
    (last_error_kind IS NULL) = (last_error_code IS NULL)
    AND (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,62}$')),
  CONSTRAINT job_ledger_dead_letter_check CHECK (
    (state IN ('dead_lettered', 'resolved')) = (dead_letter_reason IS NOT NULL)
    AND (dead_letter_reason IS NULL) = (dead_lettered_at IS NULL)
    AND (dead_letter_reason IS NULL OR dead_letter_reason IN ('retries_exhausted', 'non_retryable',
      'needs_reconnection', 'rate_limit_exhausted', 'stall_limit_exceeded', 'invalid_job'))),
  CONSTRAINT job_ledger_resolution_check CHECK ((state = 'resolved') = (resolution IS NOT NULL)
    AND (resolution IS NULL OR resolution ~ '^[a-z][a-z0-9_]{0,62}$')),
  CONSTRAINT job_ledger_completed_check CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT job_ledger_organization_id_brand_id_connection_id_fkey
    FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE
);
CREATE INDEX job_ledger_connection_id_idx ON job_ledger (connection_id);
-- Sweeper: queued rows whose Redis job may be missing.
CREATE INDEX job_ledger_queued_updated_at_idx ON job_ledger (updated_at) WHERE state = 'queued';
-- DLQ listing.
CREATE INDEX job_ledger_dlq_idx ON job_ledger (platform, dead_lettered_at)
  WHERE state IN ('dead_lettered', 'resolved');
-- Retention purge.
CREATE INDEX job_ledger_expires_at_idx ON job_ledger (expires_at) WHERE state <> 'queued';
CREATE TRIGGER job_ledger_set_updated_at_trg BEFORE UPDATE ON job_ledger
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
