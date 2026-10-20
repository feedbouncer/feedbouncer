-- Privacy and retention: transaction-scoped escape hatches for the append-only
-- guard, the records of subject requests and purge runs, and purge-scan indexes.
-- Upgrading deletes nothing. See packages/db/README.md ("Erasure requests").
BEGIN;

SET LOCAL lock_timeout = '10s';

-- Same guard as before, with two hatches checked first. Both are settings that
-- only set_config(name, 'on', true) (transaction-local) can turn on, via
-- withRetentionDelete / withPrivacyRedaction in src/privacy-guards.ts.
--   fb.retention_delete: a direct DELETE is allowed. UPDATE and TRUNCATE are not.
--   fb.privacy_redaction: an UPDATE of audit_event that changes only details
--     (and updated_at) is allowed. Nothing else is.
CREATE OR REPLACE FUNCTION fb_forbid_direct_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('fb.retention_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'audit_event'
     AND pg_catalog.current_setting('fb.privacy_redaction', true) = 'on'
     AND (pg_catalog.to_jsonb(NEW) - 'details' - 'updated_at')
       = (pg_catalog.to_jsonb(OLD) - 'details' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'TRUNCATE' OR pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- Set on a reply when its parent is erased or purged.
ALTER TABLE comment ADD COLUMN parent_removed_at timestamptz(3);

-- Fingerprints of erased comments, so a platform re-delivery is not re-ingested.
-- sha256(connection_id || NUL || comment.external_id); holds no content. Rows are
-- only inserted, so there is no updated_at (link-table exception).
CREATE TABLE erased_comment (
  connection_id uuid NOT NULL,
  fingerprint bytea NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT erased_comment_pkey PRIMARY KEY (connection_id, fingerprint),
  CONSTRAINT erased_comment_fingerprint_check CHECK (octet_length(fingerprint) = 32),
  CONSTRAINT erased_comment_connection_id_fkey FOREIGN KEY (connection_id)
    REFERENCES connection (id) ON DELETE CASCADE
);

-- One row per subject export or erasure. The requested identifiers are kept
-- sealed only while the request is unfinished and wiped when it finishes.
CREATE TABLE privacy_request (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  kind text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  requested_via text NOT NULL,
  actor_user_id uuid,
  actor_label text,
  reference text,
  subjects_sealed bytea,
  subject_count smallint NOT NULL,
  keep_rule_entries_reason text,
  found boolean,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  coverage text,
  error_code text,
  export_sha256 bytea,
  export_bytes bigint,
  export_expires_at timestamptz(3),
  started_at timestamptz(3),
  finished_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT privacy_request_pkey PRIMARY KEY (id),
  CONSTRAINT privacy_request_kind_check CHECK (kind IN ('export', 'erasure')),
  CONSTRAINT privacy_request_mode_check CHECK (mode IN ('dry_run', 'execute')),
  CONSTRAINT privacy_request_status_check CHECK (status IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT privacy_request_requested_via_check CHECK (requested_via IN ('api', 'cli')),
  CONSTRAINT privacy_request_actor_label_check CHECK (actor_label IS NULL OR actor_label ~ '^[A-Za-z0-9._@-]{1,64}$'),
  CONSTRAINT privacy_request_reference_check CHECK (reference IS NULL OR reference ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  CONSTRAINT privacy_request_subject_count_check CHECK (subject_count BETWEEN 1 AND 20),
  CONSTRAINT privacy_request_keep_rule_entries_reason_check CHECK (
    keep_rule_entries_reason IS NULL OR char_length(keep_rule_entries_reason) <= 500),
  CONSTRAINT privacy_request_counts_check CHECK (jsonb_typeof(counts) = 'object' AND octet_length(counts::text) <= 16384),
  CONSTRAINT privacy_request_error_code_check CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,64}$'),
  CONSTRAINT privacy_request_sealed_until_finished_check CHECK (
    (status IN ('done', 'failed')) = (subjects_sealed IS NULL)),
  CONSTRAINT privacy_request_export_is_executed_check CHECK (kind <> 'export' OR mode = 'execute'),
  CONSTRAINT privacy_request_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT privacy_request_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX privacy_request_organization_id_created_at_idx ON privacy_request (organization_id, created_at DESC);
CREATE INDEX privacy_request_actor_user_id_idx ON privacy_request (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX privacy_request_open_idx ON privacy_request (status, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX privacy_request_finished_at_idx ON privacy_request (finished_at) WHERE finished_at IS NOT NULL;
CREATE TRIGGER privacy_request_set_updated_at_trg BEFORE UPDATE ON privacy_request
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- One row per retention purge run (instance-wide, so no organization_id).
CREATE TABLE retention_run (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'running',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  cutoffs jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  held text[] NOT NULL DEFAULT '{}',
  skipped_pending_review integer NOT NULL DEFAULT 0,
  started_at timestamptz(3) NOT NULL DEFAULT now(),
  finished_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT retention_run_pkey PRIMARY KEY (id),
  CONSTRAINT retention_run_status_check CHECK (status IN ('running', 'done', 'failed', 'partial')),
  CONSTRAINT retention_run_skipped_pending_review_check CHECK (skipped_pending_review >= 0)
);
CREATE INDEX retention_run_finished_at_idx ON retention_run (finished_at);
CREATE TRIGGER retention_run_set_updated_at_trg BEFORE UPDATE ON retention_run
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- An operator's go-ahead for a large deletion; valid until the setting changes.
-- Only inserted, so one event timestamp (confirmed_at) and no updated_at.
CREATE TABLE retention_confirmation (
  category text NOT NULL,
  days integer NOT NULL,
  eligible_count bigint NOT NULL,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT retention_confirmation_pkey PRIMARY KEY (category, days),
  CONSTRAINT retention_confirmation_category_check CHECK (
    category IN ('comments', 'decisions', 'previews', 'operational', 'audit')),
  CONSTRAINT retention_confirmation_days_check CHECK (days BETWEEN 1 AND 36500),
  CONSTRAINT retention_confirmation_eligible_count_check CHECK (eligible_count >= 0),
  CONSTRAINT retention_confirmation_confirmed_by_check CHECK (confirmed_by ~ '^[A-Za-z0-9._@-]{1,64}$')
);

-- Single row, written by the worker at startup and after each run.
CREATE TABLE retention_status (
  id smallint NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings text[] NOT NULL DEFAULT '{}',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT retention_status_pkey PRIMARY KEY (id),
  CONSTRAINT retention_status_singleton_check CHECK (id = 1)
);
CREATE TRIGGER retention_status_set_updated_at_trg BEFORE UPDATE ON retention_status
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();
INSERT INTO retention_status (id, settings, effective, warnings) VALUES (1, '{}', '{}', '{}');

-- Purge scans. webhook_event (created_at) already has an index, and
-- comment_organization_id_ingested_at_idx already serves the comment purge.
-- The new indexes are plain CREATE INDEX and block writes while they build.
CREATE INDEX rule_evaluation_brand_id_created_at_idx ON rule_evaluation (brand_id, created_at);
CREATE INDEX policy_evaluation_brand_id_created_at_idx ON policy_evaluation (brand_id, created_at);
CREATE INDEX moderation_action_brand_id_completed_at_idx ON moderation_action (brand_id, completed_at)
  WHERE completed_at IS NOT NULL;
CREATE INDEX action_run_brand_id_created_at_idx ON action_run (brand_id, created_at);
CREATE INDEX audit_event_organization_id_created_at_idx ON audit_event (organization_id, created_at);
CREATE INDEX alert_event_created_at_idx ON alert_event (created_at);
CREATE INDEX api_idempotency_record_created_at_idx ON api_idempotency_record (created_at);

COMMIT;
