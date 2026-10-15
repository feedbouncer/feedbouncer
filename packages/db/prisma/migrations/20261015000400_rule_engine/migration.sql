-- Rule engine: rule kind/archival, own domains, evaluations, history runs.
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE rule
  ADD COLUMN kind text GENERATED ALWAYS AS (conditions ->> 'type') STORED,
  ADD COLUMN archived_at timestamptz(3),
  ADD CONSTRAINT rule_kind_check CHECK (
    kind IS NULL OR kind IN ('keyword', 'regex', 'link_domain', 'emoji', 'author', 'competitor'));
CREATE INDEX rule_brand_id_priority_idx ON rule (brand_id, priority) WHERE archived_at IS NULL;

CREATE TABLE brand_domain (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  domain text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT brand_domain_pkey PRIMARY KEY (id),
  CONSTRAINT brand_domain_brand_id_domain_key UNIQUE (brand_id, domain),
  CONSTRAINT brand_domain_domain_check CHECK (
    char_length(domain) BETWEEN 3 AND 253
    AND domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  CONSTRAINT brand_domain_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX brand_domain_organization_id_brand_id_idx ON brand_domain (organization_id, brand_id);
CREATE TRIGGER brand_domain_set_updated_at_trg BEFORE UPDATE ON brand_domain
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE rule_run (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  since timestamptz(3) NOT NULL,
  max_comments integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  enqueued_count integer NOT NULL DEFAULT 0,
  failure_code text,
  requested_by_user_id uuid,
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT rule_run_pkey PRIMARY KEY (id),
  CONSTRAINT rule_run_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT rule_run_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT rule_run_enqueued_count_check CHECK (enqueued_count >= 0),
  CONSTRAINT rule_run_max_comments_check CHECK (max_comments BETWEEN 1 AND 5000),
  CONSTRAINT rule_run_failure_code_check CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z_]{0,63}$'),
  CONSTRAINT rule_run_organization_id_brand_id_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT rule_run_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX rule_run_connection_id_idx ON rule_run (connection_id);
CREATE INDEX rule_run_requested_by_user_id_idx ON rule_run (requested_by_user_id) WHERE requested_by_user_id IS NOT NULL;
CREATE INDEX rule_run_brand_id_created_at_idx ON rule_run (brand_id, created_at DESC);
CREATE TRIGGER rule_run_set_updated_at_trg BEFORE UPDATE ON rule_run
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- One row per (comment, body version, trigger): the durable idempotency guard
-- for rule evaluation. trigger_key is 'ingest' or the rule_run id.
CREATE TABLE rule_evaluation (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  body_sha256 bytea NOT NULL,
  trigger_key text NOT NULL,
  rule_run_id uuid,
  ruleset_version text NOT NULL,
  status text NOT NULL,
  skip_reason text,
  matched_rule_id uuid,
  outcome text,
  trace jsonb NOT NULL DEFAULT '[]'::jsonb,
  fallback_at timestamptz(3),
  fallback_code text,
  recovered_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT rule_evaluation_pkey PRIMARY KEY (id),
  CONSTRAINT rule_evaluation_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT rule_evaluation_comment_id_body_sha256_trigger_key_key UNIQUE (comment_id, body_sha256, trigger_key),
  CONSTRAINT rule_evaluation_body_sha256_check CHECK (octet_length(body_sha256) = 32),
  CONSTRAINT rule_evaluation_trigger_key_check CHECK (char_length(trigger_key) BETWEEN 1 AND 64),
  CONSTRAINT rule_evaluation_status_check CHECK (status IN ('no_match', 'decided', 'skipped')),
  CONSTRAINT rule_evaluation_skip_reason_check CHECK (
    (status = 'skipped') = (skip_reason IS NOT NULL)
    AND (skip_reason IS NULL OR skip_reason IN ('own_account', 'deleted'))),
  CONSTRAINT rule_evaluation_outcome_check CHECK (
    (status = 'decided') = (outcome IS NOT NULL AND matched_rule_id IS NOT NULL)
    AND (outcome IS NULL OR outcome IN ('approve', 'hide', 'remove', 'flag'))),
  CONSTRAINT rule_evaluation_trace_check CHECK (jsonb_typeof(trace) = 'array'),
  CONSTRAINT rule_evaluation_fallback_code_check CHECK (fallback_code IS NULL OR fallback_code ~ '^[a-z][a-z_]{0,63}$'),
  CONSTRAINT rule_evaluation_organization_id_brand_id_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT rule_evaluation_brand_id_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT rule_evaluation_brand_id_matched_rule_id_fkey FOREIGN KEY (brand_id, matched_rule_id)
    REFERENCES rule (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT rule_evaluation_brand_id_rule_run_id_fkey FOREIGN KEY (brand_id, rule_run_id)
    REFERENCES rule_run (brand_id, id) ON DELETE SET NULL (rule_run_id)
);
CREATE INDEX rule_evaluation_connection_id_idx ON rule_evaluation (connection_id);
CREATE INDEX rule_evaluation_brand_id_comment_id_idx ON rule_evaluation (brand_id, comment_id);
CREATE INDEX rule_evaluation_matched_rule_id_idx ON rule_evaluation (matched_rule_id) WHERE matched_rule_id IS NOT NULL;
CREATE INDEX rule_evaluation_rule_run_id_idx ON rule_evaluation (rule_run_id) WHERE rule_run_id IS NOT NULL;
CREATE TRIGGER rule_evaluation_set_updated_at_trg BEFORE UPDATE ON rule_evaluation
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- A rule_evaluation is a durable record of why a decision was made. Only the
-- fallback bookkeeping columns may change, and rows are removed only by FK
-- cascade (comment deletion). rule_run_id may be nulled by the rule_run
-- ON DELETE SET NULL cascade (trigger depth >= 2) but never edited directly.
CREATE FUNCTION fb_rule_evaluation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.comment_id IS DISTINCT FROM OLD.comment_id
     OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
     OR NEW.trigger_key IS DISTINCT FROM OLD.trigger_key
     OR NEW.ruleset_version IS DISTINCT FROM OLD.ruleset_version
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.skip_reason IS DISTINCT FROM OLD.skip_reason
     OR NEW.matched_rule_id IS DISTINCT FROM OLD.matched_rule_id
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.trace IS DISTINCT FROM OLD.trace
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.rule_run_id IS DISTINCT FROM OLD.rule_run_id
         AND (pg_catalog.pg_trigger_depth() < 2 OR NEW.rule_run_id IS NOT NULL))
  THEN
    RAISE EXCEPTION 'rule_evaluation is immutable except fallback columns'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rule_evaluation_immutable_trg BEFORE UPDATE ON rule_evaluation
  FOR EACH ROW EXECUTE FUNCTION fb_rule_evaluation_guard();
CREATE TRIGGER rule_evaluation_no_delete_trg BEFORE DELETE ON rule_evaluation
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER rule_evaluation_no_truncate_trg BEFORE TRUNCATE ON rule_evaluation
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

ALTER TABLE decision
  ADD COLUMN rule_evaluation_id uuid,
  ADD CONSTRAINT decision_brand_id_rule_evaluation_id_fkey FOREIGN KEY (brand_id, rule_evaluation_id)
    REFERENCES rule_evaluation (brand_id, id) ON DELETE CASCADE;
CREATE INDEX decision_rule_evaluation_id_idx ON decision (rule_evaluation_id)
  WHERE rule_evaluation_id IS NOT NULL;

COMMIT;
