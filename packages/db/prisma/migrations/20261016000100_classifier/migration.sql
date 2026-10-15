BEGIN;
SET LOCAL lock_timeout = '10s';

-- Per-brand overrides; a missing row means the built-in default for that category.
CREATE TABLE classifier_threshold (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  category text NOT NULL,
  threshold numeric(5, 4) NOT NULL,
  action text NOT NULL,
  updated_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT classifier_threshold_pkey PRIMARY KEY (id),
  CONSTRAINT classifier_threshold_brand_id_category_key UNIQUE (brand_id, category),
  CONSTRAINT classifier_threshold_category_check CHECK (category IN
    ('spam', 'scam_phishing', 'harassment_abuse', 'hate_speech', 'sexual_content', 'profanity', 'self_promotion')),
  CONSTRAINT classifier_threshold_threshold_check CHECK (threshold >= 0 AND threshold <= 1),
  CONSTRAINT classifier_threshold_action_check CHECK (action IN ('approve', 'flag', 'hide', 'remove')),
  CONSTRAINT classifier_threshold_brand_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT classifier_threshold_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX classifier_threshold_updated_by_user_id_idx ON classifier_threshold (updated_by_user_id);
CREATE TRIGGER classifier_threshold_set_updated_at_trg BEFORE UPDATE ON classifier_threshold
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE FUNCTION fb_valid_classifier_scores(s jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN jsonb_typeof(s) IS DISTINCT FROM 'object' THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(s)) <> 7 THEN false
    WHEN NOT (s ?& ARRAY['spam', 'scam_phishing', 'harassment_abuse', 'hate_speech', 'sexual_content', 'profanity', 'self_promotion']) THEN false
    ELSE coalesce((SELECT bool_and(jsonb_typeof(e.v) = 'number'
                                   AND CASE WHEN jsonb_typeof(e.v) = 'number' THEN (e.v #>> '{}')::numeric BETWEEN 0 AND 1 ELSE false END)
                     FROM jsonb_each(s) AS e(k, v)), false)
  END
$$;

CREATE TABLE comment_classification (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  body_sha256 bytea NOT NULL,
  trigger_key text NOT NULL,
  status text NOT NULL,
  skip_reason text,
  unclassified_reason text,
  provider text,
  model text,
  prompt_version text,
  scores jsonb,
  language text,
  language_supported boolean,
  low_signal boolean NOT NULL DEFAULT false,
  truncated boolean NOT NULL DEFAULT false,
  input_chars integer NOT NULL,
  scores_reused boolean NOT NULL DEFAULT false,
  rule_evaluation_id uuid,
  rule_decided boolean NOT NULL DEFAULT false,
  policy jsonb,
  outcome text,
  triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  downgraded text,
  fallback_at timestamptz(3),
  fallback_code text,
  recovered_at timestamptz(3),
  reversed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT comment_classification_pkey PRIMARY KEY (id),
  CONSTRAINT comment_classification_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT comment_classification_comment_id_body_sha256_trigger_key_key UNIQUE (comment_id, body_sha256, trigger_key),
  CONSTRAINT comment_classification_body_sha256_check CHECK (octet_length(body_sha256) = 32),
  CONSTRAINT comment_classification_trigger_key_check CHECK (trigger_key ~ '^(ingest|rerun:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT comment_classification_status_check CHECK (
       (status = 'classified' AND scores IS NOT NULL AND provider IS NOT NULL AND model IS NOT NULL
        AND prompt_version IS NOT NULL AND policy IS NOT NULL AND language IS NOT NULL AND language_supported IS NOT NULL
        AND skip_reason IS NULL AND unclassified_reason IS NULL)
    OR (status = 'unclassified' AND unclassified_reason IS NOT NULL AND scores IS NULL AND outcome IS NULL AND skip_reason IS NULL)
    OR (status = 'skipped' AND skip_reason IS NOT NULL AND scores IS NULL AND outcome IS NULL AND unclassified_reason IS NULL)),
  CONSTRAINT comment_classification_skip_reason_check CHECK (skip_reason IN ('deleted', 'own_account', 'rules_not_evaluated')),
  CONSTRAINT comment_classification_unclassified_reason_check CHECK (unclassified_reason IN
    ('timeout', 'rate_limited', 'unavailable', 'auth', 'invalid_output', 'bad_request', 'disabled', 'queue_timeout')),
  CONSTRAINT comment_classification_provider_check CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$'),
  CONSTRAINT comment_classification_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  CONSTRAINT comment_classification_prompt_version_check CHECK (prompt_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  CONSTRAINT comment_classification_scores_check CHECK (scores IS NULL OR fb_valid_classifier_scores(scores)),
  CONSTRAINT comment_classification_language_check CHECK (language ~ '^([a-z]{2,3}|und)$'),
  CONSTRAINT comment_classification_input_chars_check CHECK (input_chars >= 0),
  CONSTRAINT comment_classification_policy_check CHECK (policy IS NULL OR jsonb_typeof(policy) = 'array'),
  CONSTRAINT comment_classification_triggers_check CHECK (jsonb_typeof(triggers) = 'array'),
  CONSTRAINT comment_classification_outcome_check CHECK (outcome IN ('approve', 'flag', 'hide', 'remove')),
  CONSTRAINT comment_classification_rule_decided_check CHECK (NOT rule_decided OR outcome IS NULL),
  CONSTRAINT comment_classification_downgraded_check CHECK (downgraded IN ('low_signal', 'unsupported_language')),
  CONSTRAINT comment_classification_fallback_check CHECK ((fallback_at IS NULL) = (fallback_code IS NULL)),
  CONSTRAINT comment_classification_fallback_code_check CHECK (fallback_code ~ '^[a-z][a-z_]{0,63}$'),
  CONSTRAINT comment_classification_connection_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_classification_comment_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_classification_rule_evaluation_fkey FOREIGN KEY (brand_id, rule_evaluation_id)
    REFERENCES rule_evaluation (brand_id, id) ON DELETE CASCADE
);
CREATE INDEX comment_classification_connection_id_idx ON comment_classification (connection_id);
CREATE INDEX comment_classification_brand_id_created_at_idx ON comment_classification (brand_id, created_at DESC);
CREATE INDEX comment_classification_brand_id_trigger_key_idx ON comment_classification (brand_id, trigger_key) WHERE trigger_key <> 'ingest';
CREATE INDEX comment_classification_rule_evaluation_id_idx ON comment_classification (rule_evaluation_id)
  WHERE rule_evaluation_id IS NOT NULL;
CREATE TRIGGER comment_classification_set_updated_at_trg BEFORE UPDATE ON comment_classification
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Only the write-once outcome columns may change (null -> value), everything else is immutable.
CREATE FUNCTION fb_comment_classification_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['fallback_at', 'fallback_code', 'recovered_at', 'reversed_at', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['fallback_at', 'fallback_code', 'recovered_at', 'reversed_at', 'updated_at']) THEN
    RAISE EXCEPTION 'comment_classification is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.fallback_at IS NOT NULL AND NEW.fallback_at IS DISTINCT FROM OLD.fallback_at)
     OR (OLD.fallback_code IS NOT NULL AND NEW.fallback_code IS DISTINCT FROM OLD.fallback_code)
     OR (OLD.recovered_at IS NOT NULL AND NEW.recovered_at IS DISTINCT FROM OLD.recovered_at)
     OR (OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at) THEN
    RAISE EXCEPTION 'comment_classification outcome columns are write-once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER comment_classification_immutable_trg BEFORE UPDATE ON comment_classification
  FOR EACH ROW EXECUTE FUNCTION fb_comment_classification_guard();
CREATE TRIGGER comment_classification_no_delete_trg BEFORE DELETE ON comment_classification
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER comment_classification_no_truncate_trg BEFORE TRUNCATE ON comment_classification
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

CREATE TABLE classifier_run (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  requested_by_user_id uuid,
  days integer NOT NULL,
  since timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT classifier_run_pkey PRIMARY KEY (id),
  CONSTRAINT classifier_run_days_check CHECK (days BETWEEN 1 AND 30),
  CONSTRAINT classifier_run_brand_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT classifier_run_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX classifier_run_brand_id_created_at_idx ON classifier_run (brand_id, created_at DESC);
CREATE INDEX classifier_run_requested_by_user_id_idx ON classifier_run (requested_by_user_id);
CREATE TRIGGER classifier_run_set_updated_at_trg BEFORE UPDATE ON classifier_run
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

ALTER TABLE decision ADD COLUMN classification_id uuid, ADD COLUMN threshold numeric(5, 4);
ALTER TABLE decision ADD CONSTRAINT decision_classification_fkey FOREIGN KEY (brand_id, classification_id)
  REFERENCES comment_classification (brand_id, id) ON DELETE CASCADE;
ALTER TABLE decision ADD CONSTRAINT decision_threshold_check
  CHECK (threshold IS NULL OR (threshold >= 0 AND threshold <= 1 AND actor_type = 'classifier'));
ALTER TABLE decision ADD CONSTRAINT decision_classifier_evidence_check CHECK (
  classification_id IS NULL
  OR (actor_type = 'classifier' AND category IS NOT NULL AND confidence IS NOT NULL AND threshold IS NOT NULL));
CREATE INDEX decision_classification_id_idx ON decision (classification_id) WHERE classification_id IS NOT NULL;

COMMIT;
