-- Moderation: brand rules and the append-only decision log.
BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE rule (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  name text NOT NULL,
  conditions jsonb NOT NULL,
  action text NOT NULL,
  mode text NOT NULL DEFAULT 'suggest',
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT rule_pkey PRIMARY KEY (id),
  CONSTRAINT rule_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT rule_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT rule_conditions_check CHECK (jsonb_typeof(conditions) = 'object'),
  CONSTRAINT rule_action_check CHECK (action IN ('approve', 'hide', 'remove', 'flag')),
  CONSTRAINT rule_mode_check CHECK (mode IN ('enforce', 'suggest')),
  CONSTRAINT rule_priority_check CHECK (priority BETWEEN 0 AND 10000),
  CONSTRAINT rule_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE
);
CREATE TRIGGER rule_set_updated_at_trg BEFORE UPDATE ON rule
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Append-only. "Restore" is a new 'approve' decision. Latest decision:
--   SELECT ... FROM decision WHERE comment_id = $1 AND brand_id = $2 ORDER BY sequence DESC LIMIT 1
-- sequence is internal ordering only; never expose it outside the system.
-- actor_user_id may be NULL for actor_type 'user' only after that user was erased.
CREATE TABLE decision (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  outcome text NOT NULL,
  mode text NOT NULL,
  actor_type text NOT NULL,
  actor_user_id uuid,
  rule_id uuid,
  classifier_provider text,
  classifier_model text,
  category text,
  confidence numeric(5, 4),
  reason text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT decision_pkey PRIMARY KEY (id),
  CONSTRAINT decision_sequence_key UNIQUE (sequence),
  CONSTRAINT decision_outcome_check CHECK (outcome IN ('approve', 'hide', 'remove', 'flag')),
  CONSTRAINT decision_mode_check CHECK (mode IN ('enforce', 'suggest')),
  CONSTRAINT decision_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier')),
  CONSTRAINT decision_actor_check CHECK (
       (actor_type = 'user' AND rule_id IS NULL AND classifier_provider IS NULL AND classifier_model IS NULL)
    OR (actor_type = 'rule' AND rule_id IS NOT NULL AND actor_user_id IS NULL
        AND classifier_provider IS NULL AND classifier_model IS NULL)
    OR (actor_type = 'classifier' AND classifier_provider IS NOT NULL AND classifier_model IS NOT NULL
        AND actor_user_id IS NULL AND rule_id IS NULL)),
  CONSTRAINT decision_classifier_provider_check CHECK (
    classifier_provider IS NULL OR classifier_provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$'),
  CONSTRAINT decision_classifier_model_check CHECK (
    classifier_model IS NULL OR classifier_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  CONSTRAINT decision_category_check CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 100),
  CONSTRAINT decision_confidence_check CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT decision_reason_check CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT decision_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT decision_brand_id_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  -- Deferred so brand/org cascades can remove cited rules; a direct rule delete
  -- still fails at commit. Retire rules with enabled = false.
  CONSTRAINT decision_brand_id_rule_id_fkey FOREIGN KEY (brand_id, rule_id)
    REFERENCES rule (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT decision_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX decision_comment_id_sequence_idx ON decision (comment_id, sequence DESC);
CREATE INDEX decision_brand_id_created_at_idx ON decision (brand_id, created_at DESC);
CREATE INDEX decision_rule_id_idx ON decision (rule_id) WHERE rule_id IS NOT NULL;
CREATE INDEX decision_actor_user_id_idx ON decision (actor_user_id) WHERE actor_user_id IS NOT NULL;

CREATE FUNCTION fb_decision_require_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_type = 'user' AND NEW.actor_user_id IS NULL THEN
    RAISE EXCEPTION 'decision by a user must set actor_user_id'
      USING ERRCODE = 'not_null_violation', COLUMN = 'actor_user_id';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER decision_require_actor_trg BEFORE INSERT ON decision
  FOR EACH ROW EXECUTE FUNCTION fb_decision_require_actor();
CREATE TRIGGER decision_append_only_trg BEFORE UPDATE OR DELETE ON decision
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER decision_no_truncate_trg BEFORE TRUNCATE ON decision
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

COMMIT;
