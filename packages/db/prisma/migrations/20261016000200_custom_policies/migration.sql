BEGIN;
SET LOCAL lock_timeout = '10s';

-- Plain-language moderation policies. A policy is a name, an enabled flag and a
-- sequence of immutable revisions (text + action); decisions point at the revision.
CREATE TABLE custom_policy (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  archived_at timestamptz(3),
  created_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT custom_policy_pkey PRIMARY KEY (id),
  CONSTRAINT custom_policy_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT custom_policy_name_check CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT custom_policy_archived_check CHECK (archived_at IS NULL OR NOT enabled),
  CONSTRAINT custom_policy_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT custom_policy_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX custom_policy_brand_id_name_key ON custom_policy (brand_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX custom_policy_organization_id_brand_id_idx ON custom_policy (organization_id, brand_id);
CREATE INDEX custom_policy_brand_id_enabled_idx ON custom_policy (brand_id, created_at, id) WHERE enabled;
CREATE INDEX custom_policy_created_by_user_id_idx ON custom_policy (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE TRIGGER custom_policy_set_updated_at_trg BEFORE UPDATE ON custom_policy
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE custom_policy_revision (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  revision integer NOT NULL,
  text text NOT NULL,
  action text NOT NULL,
  vague boolean NOT NULL,
  created_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT custom_policy_revision_pkey PRIMARY KEY (id),
  CONSTRAINT custom_policy_revision_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT custom_policy_revision_policy_id_revision_key UNIQUE (policy_id, revision),
  CONSTRAINT custom_policy_revision_revision_check CHECK (revision >= 1),
  CONSTRAINT custom_policy_revision_text_check CHECK (char_length(text) BETWEEN 8 AND 500),
  CONSTRAINT custom_policy_revision_action_check CHECK (action IN ('flag', 'hide', 'remove')),
  CONSTRAINT custom_policy_revision_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT custom_policy_revision_policy_id_fkey FOREIGN KEY (brand_id, policy_id)
    REFERENCES custom_policy (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT custom_policy_revision_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX custom_policy_revision_organization_id_brand_id_idx ON custom_policy_revision (organization_id, brand_id);
CREATE INDEX custom_policy_revision_created_by_user_id_idx ON custom_policy_revision (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
-- Append-only: edit a policy by adding a revision.
CREATE TRIGGER custom_policy_revision_set_updated_at_trg BEFORE UPDATE ON custom_policy_revision
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();
CREATE TRIGGER custom_policy_revision_append_only_trg BEFORE UPDATE OR DELETE ON custom_policy_revision
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER custom_policy_revision_no_truncate_trg BEFORE TRUNCATE ON custom_policy_revision
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

-- One policy check of one comment body version.
CREATE TABLE policy_evaluation (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  body_sha256 bytea NOT NULL,
  trigger_key text NOT NULL,
  rule_evaluation_id uuid,
  status text NOT NULL,
  skip_reason text,
  failure_code text,
  provider text,
  model text,
  prompt_version text,
  checked_revision_ids uuid[] NOT NULL DEFAULT '{}',
  input_truncated boolean,
  low_signal boolean,
  outcome text,
  winning_revision_id uuid,
  fallback_at timestamptz(3),
  fallback_code text,
  recovered_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT policy_evaluation_pkey PRIMARY KEY (id),
  CONSTRAINT policy_evaluation_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT policy_evaluation_comment_id_body_sha256_trigger_key_key UNIQUE (comment_id, body_sha256, trigger_key),
  CONSTRAINT policy_evaluation_body_sha256_check CHECK (octet_length(body_sha256) = 32),
  CONSTRAINT policy_evaluation_trigger_key_check CHECK (
    trigger_key ~ '^(ingest|run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT policy_evaluation_status_check CHECK (
       (status = 'evaluated' AND skip_reason IS NULL AND failure_code IS NULL AND provider IS NOT NULL
        AND model IS NOT NULL AND prompt_version IS NOT NULL AND input_truncated IS NOT NULL AND low_signal IS NOT NULL
        AND cardinality(checked_revision_ids) BETWEEN 1 AND 10)
    OR (status = 'failed' AND skip_reason IS NULL AND failure_code IS NOT NULL AND failure_code ~ '^[a-z][a-z_]{0,63}$'
        AND outcome IS NULL)
    OR (status = 'skipped' AND failure_code IS NULL AND outcome IS NULL AND skip_reason IN
        ('deleted', 'own_account', 'rules_not_evaluated', 'rule_decided', 'no_enabled_policies',
         'quota_exhausted', 'policy_changed'))),
  CONSTRAINT policy_evaluation_outcome_check CHECK (
    (outcome IS NULL AND winning_revision_id IS NULL)
    OR (outcome IN ('flag', 'hide', 'remove') AND winning_revision_id IS NOT NULL)),
  CONSTRAINT policy_evaluation_provider_check CHECK (provider IS NULL OR provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$'),
  CONSTRAINT policy_evaluation_model_check CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  CONSTRAINT policy_evaluation_prompt_version_check CHECK (prompt_version IS NULL OR prompt_version ~ '^[a-z0-9-]{1,32}$'),
  CONSTRAINT policy_evaluation_fallback_check CHECK (
    (fallback_at IS NULL) = (fallback_code IS NULL)
    AND (fallback_code IS NULL OR fallback_code ~ '^[a-z][a-z_]{0,63}$')
    AND (recovered_at IS NULL OR fallback_at IS NOT NULL)),
  CONSTRAINT policy_evaluation_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_evaluation_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_evaluation_rule_evaluation_id_fkey FOREIGN KEY (brand_id, rule_evaluation_id)
    REFERENCES rule_evaluation (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_evaluation_winning_revision_id_fkey FOREIGN KEY (brand_id, winning_revision_id)
    REFERENCES custom_policy_revision (brand_id, id) ON DELETE CASCADE
);
CREATE INDEX policy_evaluation_connection_id_idx ON policy_evaluation (connection_id);
CREATE INDEX policy_evaluation_brand_id_comment_id_idx ON policy_evaluation (brand_id, comment_id, created_at DESC);
CREATE INDEX policy_evaluation_rule_evaluation_id_idx ON policy_evaluation (rule_evaluation_id)
  WHERE rule_evaluation_id IS NOT NULL;
CREATE INDEX policy_evaluation_winning_revision_id_idx ON policy_evaluation (winning_revision_id)
  WHERE winning_revision_id IS NOT NULL;
CREATE TRIGGER policy_evaluation_set_updated_at_trg BEFORE UPDATE ON policy_evaluation
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Only the write-once fallback columns may change (NULL -> value); rows go away only by FK cascade.
CREATE FUNCTION fb_policy_evaluation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['fallback_at', 'fallback_code', 'recovered_at', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['fallback_at', 'fallback_code', 'recovered_at', 'updated_at'])
     OR (OLD.fallback_at IS NOT NULL
         AND (NEW.fallback_at IS DISTINCT FROM OLD.fallback_at
              OR NEW.fallback_code IS DISTINCT FROM OLD.fallback_code))
     OR (OLD.recovered_at IS NOT NULL AND NEW.recovered_at IS DISTINCT FROM OLD.recovered_at)
  THEN
    RAISE EXCEPTION 'policy_evaluation is immutable except write-once fallback columns'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER policy_evaluation_immutable_trg BEFORE UPDATE ON policy_evaluation
  FOR EACH ROW EXECUTE FUNCTION fb_policy_evaluation_guard();
CREATE TRIGGER policy_evaluation_no_delete_trg BEFORE DELETE ON policy_evaluation
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER policy_evaluation_no_truncate_trg BEFORE TRUNCATE ON policy_evaluation
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

CREATE TABLE policy_evaluation_match (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  confidence text NOT NULL,
  configured_action text NOT NULL,
  effective_action text NOT NULL,
  downgrade text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT policy_evaluation_match_pkey PRIMARY KEY (id),
  CONSTRAINT policy_evaluation_match_evaluation_id_revision_id_key UNIQUE (evaluation_id, revision_id),
  CONSTRAINT policy_evaluation_match_confidence_check CHECK (confidence IN ('high', 'low')),
  CONSTRAINT policy_evaluation_match_configured_action_check CHECK (configured_action IN ('flag', 'hide', 'remove')),
  CONSTRAINT policy_evaluation_match_effective_action_check CHECK (effective_action IN ('flag', 'hide', 'remove')),
  CONSTRAINT policy_evaluation_match_downgrade_check CHECK (
    downgrade IS NULL OR downgrade IN ('low_confidence', 'low_signal', 'moderator_acted')),
  CONSTRAINT policy_evaluation_match_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_evaluation_match_evaluation_id_fkey FOREIGN KEY (brand_id, evaluation_id)
    REFERENCES policy_evaluation (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_evaluation_match_revision_id_fkey FOREIGN KEY (brand_id, revision_id)
    REFERENCES custom_policy_revision (brand_id, id) ON DELETE CASCADE
);
CREATE INDEX policy_evaluation_match_brand_id_idx ON policy_evaluation_match (brand_id, organization_id);
CREATE INDEX policy_evaluation_match_revision_id_idx ON policy_evaluation_match (revision_id);
CREATE TRIGGER policy_evaluation_match_set_updated_at_trg BEFORE UPDATE ON policy_evaluation_match
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();
CREATE TRIGGER policy_evaluation_match_append_only_trg BEFORE UPDATE OR DELETE ON policy_evaluation_match
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER policy_evaluation_match_no_truncate_trg BEFORE TRUNCATE ON policy_evaluation_match
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

-- Dry-run previews of draft policy text. Never referenced by decisions; pruned after 7 days.
CREATE TABLE policy_preview (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  policy_id uuid,
  requested_by_user_id uuid,
  text text NOT NULL,
  action text NOT NULL,
  days integer NOT NULL,
  since timestamptz(3) NOT NULL,
  total integer NOT NULL,
  capped boolean NOT NULL,
  status text NOT NULL DEFAULT 'running',
  stopped_reason text,
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT policy_preview_pkey PRIMARY KEY (id),
  CONSTRAINT policy_preview_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT policy_preview_text_check CHECK (char_length(text) BETWEEN 8 AND 500),
  CONSTRAINT policy_preview_action_check CHECK (action IN ('flag', 'hide', 'remove')),
  CONSTRAINT policy_preview_days_check CHECK (days BETWEEN 1 AND 14),
  CONSTRAINT policy_preview_total_check CHECK (total BETWEEN 0 AND 200),
  CONSTRAINT policy_preview_status_check CHECK (
    (status = 'running' AND completed_at IS NULL AND stopped_reason IS NULL)
    OR (status = 'done' AND completed_at IS NOT NULL
        AND (stopped_reason IS NULL OR stopped_reason IN ('quota_exhausted', 'evaluator_disabled')))),
  CONSTRAINT policy_preview_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_preview_policy_id_fkey FOREIGN KEY (brand_id, policy_id)
    REFERENCES custom_policy (brand_id, id) ON DELETE SET NULL (policy_id),
  CONSTRAINT policy_preview_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX policy_preview_organization_id_brand_id_idx ON policy_preview (organization_id, brand_id, created_at DESC);
CREATE INDEX policy_preview_policy_id_idx ON policy_preview (policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX policy_preview_requested_by_user_id_idx ON policy_preview (requested_by_user_id)
  WHERE requested_by_user_id IS NOT NULL;
CREATE UNIQUE INDEX policy_preview_brand_id_running_key ON policy_preview (brand_id) WHERE status = 'running';
CREATE TRIGGER policy_preview_set_updated_at_trg BEFORE UPDATE ON policy_preview
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE policy_preview_result (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  preview_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  position integer NOT NULL,
  verdict text,
  proposed_action text,
  reason text,
  error_code text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT policy_preview_result_pkey PRIMARY KEY (id),
  CONSTRAINT policy_preview_result_preview_id_comment_id_key UNIQUE (preview_id, comment_id),
  CONSTRAINT policy_preview_result_preview_id_position_key UNIQUE (preview_id, position),
  CONSTRAINT policy_preview_result_verdict_check CHECK (
       (verdict IS NULL AND proposed_action IS NULL AND reason IS NULL AND error_code IS NULL)
    OR (verdict IN ('clear_match', 'possible_match') AND proposed_action IN ('flag', 'hide', 'remove')
        AND char_length(reason) BETWEEN 1 AND 500 AND error_code IS NULL)
    OR (verdict = 'no_match' AND proposed_action IS NULL AND error_code IS NULL)
    OR (verdict = 'skipped' AND proposed_action IS NULL AND error_code IS NULL)
    OR (verdict = 'error' AND proposed_action IS NULL AND error_code ~ '^[a-z][a-z_]{0,63}$')),
  CONSTRAINT policy_preview_result_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_preview_result_preview_id_fkey FOREIGN KEY (brand_id, preview_id)
    REFERENCES policy_preview (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_preview_result_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_preview_result_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE
);
CREATE INDEX policy_preview_result_brand_id_idx ON policy_preview_result (brand_id, organization_id);
CREATE INDEX policy_preview_result_connection_id_idx ON policy_preview_result (connection_id);
CREATE INDEX policy_preview_result_pending_idx ON policy_preview_result (preview_id, connection_id, position)
  WHERE verdict IS NULL;
CREATE INDEX policy_preview_result_comment_id_idx ON policy_preview_result (comment_id);
CREATE TRIGGER policy_preview_result_set_updated_at_trg BEFORE UPDATE ON policy_preview_result
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Explicit "apply to recent comments" for one policy revision.
CREATE TABLE policy_run (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  days integer NOT NULL,
  since timestamptz(3) NOT NULL,
  requested_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT policy_run_pkey PRIMARY KEY (id),
  CONSTRAINT policy_run_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT policy_run_days_check CHECK (days BETWEEN 1 AND 7),
  CONSTRAINT policy_run_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_run_policy_id_fkey FOREIGN KEY (brand_id, policy_id)
    REFERENCES custom_policy (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_run_revision_id_fkey FOREIGN KEY (brand_id, revision_id)
    REFERENCES custom_policy_revision (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_run_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX policy_run_organization_id_brand_id_idx ON policy_run (organization_id, brand_id, created_at DESC);
CREATE INDEX policy_run_policy_id_idx ON policy_run (policy_id);
CREATE INDEX policy_run_revision_id_idx ON policy_run (revision_id);
CREATE INDEX policy_run_requested_by_user_id_idx ON policy_run (requested_by_user_id) WHERE requested_by_user_id IS NOT NULL;
CREATE TRIGGER policy_run_set_updated_at_trg BEFORE UPDATE ON policy_run
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Model calls per brand per UTC month (live + preview + run).
CREATE TABLE policy_usage (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  period_start date NOT NULL,
  model_calls integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT policy_usage_pkey PRIMARY KEY (id),
  CONSTRAINT policy_usage_brand_id_period_start_key UNIQUE (brand_id, period_start),
  CONSTRAINT policy_usage_model_calls_check CHECK (model_calls >= 0),
  CONSTRAINT policy_usage_period_start_check CHECK (extract(day FROM period_start) = 1),
  CONSTRAINT policy_usage_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX policy_usage_organization_id_brand_id_idx ON policy_usage (organization_id, brand_id);
CREATE TRIGGER policy_usage_set_updated_at_trg BEFORE UPDATE ON policy_usage
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Decisions made by a policy. Deferred NO ACTION (as decision_brand_id_rule_id_fkey): brand and
-- comment cascades still work, but a direct policy hard delete cannot remove decisions.
ALTER TABLE decision
  ADD COLUMN policy_evaluation_id uuid,
  ADD COLUMN policy_revision_id uuid;
ALTER TABLE decision
  ADD CONSTRAINT decision_policy_evaluation_id_fkey FOREIGN KEY (brand_id, policy_evaluation_id)
    REFERENCES policy_evaluation (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT decision_policy_revision_id_fkey FOREIGN KEY (brand_id, policy_revision_id)
    REFERENCES custom_policy_revision (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX decision_policy_evaluation_id_idx ON decision (policy_evaluation_id) WHERE policy_evaluation_id IS NOT NULL;
CREATE INDEX decision_policy_revision_id_idx ON decision (policy_revision_id) WHERE policy_revision_id IS NOT NULL;
ALTER TABLE decision DROP CONSTRAINT decision_actor_type_check,
  ADD CONSTRAINT decision_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier', 'policy'));
ALTER TABLE decision DROP CONSTRAINT decision_actor_check,
  ADD CONSTRAINT decision_actor_check CHECK (
       (actor_type = 'user' AND rule_id IS NULL AND classifier_provider IS NULL AND classifier_model IS NULL)
    OR (actor_type = 'rule' AND rule_id IS NOT NULL AND actor_user_id IS NULL
        AND classifier_provider IS NULL AND classifier_model IS NULL)
    OR (actor_type = 'classifier' AND classifier_provider IS NOT NULL AND classifier_model IS NOT NULL
        AND actor_user_id IS NULL AND rule_id IS NULL)
    OR (actor_type = 'policy' AND policy_evaluation_id IS NOT NULL AND policy_revision_id IS NOT NULL
        AND actor_user_id IS NULL AND rule_id IS NULL AND classifier_provider IS NULL AND classifier_model IS NULL));
ALTER TABLE decision ADD CONSTRAINT decision_policy_evidence_check CHECK (
  (policy_evaluation_id IS NULL AND policy_revision_id IS NULL) OR actor_type = 'policy');

ALTER TABLE moderation_action DROP CONSTRAINT moderation_action_actor_type_check,
  ADD CONSTRAINT moderation_action_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier', 'system', 'policy'));
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_type_check,
  ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'rule', 'classifier', 'policy'));

COMMIT;
