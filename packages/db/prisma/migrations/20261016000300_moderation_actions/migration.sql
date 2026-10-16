-- Moderation actions: ordered action steps on rules, durable per-evaluation action
-- runs with one row per step, and the review queue that "flag" decisions feed.
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE rule
  ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT rule_actions_check CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 6);

-- rule.action stays for decision outcomes; actions is what executes. Converting a
-- 'remove' rule keeps the owner's explicit choice to delete.
UPDATE rule SET actions = CASE action
  WHEN 'hide' THEN '[{"type":"hide"}]'::jsonb
  WHEN 'remove' THEN '[{"type":"delete","confirmIrreversible":true}]'::jsonb
  WHEN 'flag' THEN '[{"type":"flag_for_review"}]'::jsonb
  ELSE '[]'::jsonb
END;

-- Comments waiting for a human. At most one open item per comment. decision_id is a
-- plain reference, not a foreign key: a key would block TRUNCATE on the append-only
-- decision log before its guard trigger could refuse it.
CREATE TABLE review_item (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  source text NOT NULL,
  decision_id uuid,
  rule_id uuid,
  status text NOT NULL DEFAULT 'open',
  resolution text,
  resolution_action_id uuid,
  resolved_by_user_id uuid,
  resolved_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT review_item_pkey PRIMARY KEY (id),
  CONSTRAINT review_item_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT review_item_source_check CHECK (source IN ('rule', 'classifier', 'policy', 'user', 'action_step')),
  CONSTRAINT review_item_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT review_item_resolution_check CHECK (
    resolution IS NULL OR resolution IN ('approved', 'hidden', 'deleted', 'banned', 'dismissed')),
  CONSTRAINT review_item_resolved_check CHECK (
    (status = 'resolved') = (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT review_item_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT review_item_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT review_item_rule_id_fkey FOREIGN KEY (brand_id, rule_id)
    REFERENCES rule (brand_id, id) ON DELETE SET NULL (rule_id),
  CONSTRAINT review_item_resolution_action_id_fkey FOREIGN KEY (brand_id, resolution_action_id)
    REFERENCES moderation_action (brand_id, id) ON DELETE SET NULL (resolution_action_id),
  CONSTRAINT review_item_resolved_by_user_id_fkey FOREIGN KEY (resolved_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL (resolved_by_user_id)
);
CREATE UNIQUE INDEX review_item_open_comment_key ON review_item (comment_id) WHERE status = 'open';
CREATE INDEX review_item_organization_id_brand_id_status_created_at_idx
  ON review_item (organization_id, brand_id, status, created_at DESC);
CREATE INDEX review_item_connection_id_idx ON review_item (connection_id);
CREATE INDEX review_item_comment_id_idx ON review_item (comment_id);
CREATE INDEX review_item_rule_id_idx ON review_item (rule_id) WHERE rule_id IS NOT NULL;
CREATE INDEX review_item_resolution_action_id_idx ON review_item (resolution_action_id)
  WHERE resolution_action_id IS NOT NULL;
CREATE INDEX review_item_resolved_by_user_id_idx ON review_item (resolved_by_user_id)
  WHERE resolved_by_user_id IS NOT NULL;
CREATE TRIGGER review_item_set_updated_at_trg BEFORE UPDATE ON review_item
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- A rule's steps run once per (evaluation, rule); dry_run runs only simulate.
CREATE TABLE action_run (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_evaluation_id uuid NOT NULL,
  dry_run boolean NOT NULL,
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT action_run_pkey PRIMARY KEY (id),
  CONSTRAINT action_run_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT action_run_evaluation_rule_key UNIQUE (rule_evaluation_id, rule_id),
  CONSTRAINT action_run_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT action_run_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  -- Deferred like decision's rule FK so brand/org cascades can remove the rule;
  -- a direct rule delete still fails at commit. Retire rules with archived_at.
  CONSTRAINT action_run_rule_id_fkey FOREIGN KEY (brand_id, rule_id)
    REFERENCES rule (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT action_run_rule_evaluation_id_fkey FOREIGN KEY (rule_evaluation_id)
    REFERENCES rule_evaluation (id) ON DELETE CASCADE
);
CREATE INDEX action_run_connection_id_idx ON action_run (connection_id);
CREATE INDEX action_run_comment_id_idx ON action_run (comment_id);
CREATE INDEX action_run_rule_id_idx ON action_run (rule_id);
CREATE INDEX action_run_open_idx ON action_run (created_at) WHERE completed_at IS NULL;
CREATE TRIGGER action_run_set_updated_at_trg BEFORE UPDATE ON action_run
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE action_run_step (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  run_id uuid NOT NULL,
  position smallint NOT NULL,
  step_type text NOT NULL,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason_code text,
  request_key text,
  moderation_action_id uuid,
  review_item_id uuid,
  preview_text text,
  undo_action_id uuid,
  undone_at timestamptz(3),
  undone_by_user_id uuid,
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT action_run_step_pkey PRIMARY KEY (id),
  CONSTRAINT action_run_step_run_id_step_type_key UNIQUE (run_id, step_type),
  CONSTRAINT action_run_step_run_id_position_key UNIQUE (run_id, position),
  CONSTRAINT action_run_step_step_type_check CHECK (
    step_type IN ('hide', 'delete', 'ban', 'auto_reply', 'private_reply', 'flag_for_review')),
  CONSTRAINT action_run_step_status_check CHECK (
    status IN ('pending', 'succeeded', 'failed', 'skipped', 'not_applicable', 'not_supported', 'simulated')),
  CONSTRAINT action_run_step_reason_code_check CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT action_run_step_completed_check CHECK ((status = 'pending') = (completed_at IS NULL)),
  CONSTRAINT action_run_step_preview_text_check CHECK (
    preview_text IS NULL OR (status = 'simulated' AND char_length(preview_text) <= 8000)),
  CONSTRAINT action_run_step_undone_check CHECK ((undone_at IS NULL) = (undone_by_user_id IS NULL)),
  CONSTRAINT action_run_step_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT action_run_step_run_id_fkey FOREIGN KEY (brand_id, run_id)
    REFERENCES action_run (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT action_run_step_moderation_action_id_fkey FOREIGN KEY (brand_id, moderation_action_id)
    REFERENCES moderation_action (brand_id, id) ON DELETE SET NULL (moderation_action_id),
  CONSTRAINT action_run_step_undo_action_id_fkey FOREIGN KEY (brand_id, undo_action_id)
    REFERENCES moderation_action (brand_id, id) ON DELETE SET NULL (undo_action_id),
  CONSTRAINT action_run_step_review_item_id_fkey FOREIGN KEY (brand_id, review_item_id)
    REFERENCES review_item (brand_id, id) ON DELETE SET NULL (review_item_id)
);
CREATE UNIQUE INDEX action_run_step_moderation_action_key ON action_run_step (moderation_action_id)
  WHERE moderation_action_id IS NOT NULL;
CREATE INDEX action_run_step_brand_id_idx ON action_run_step (brand_id);
CREATE INDEX action_run_step_undo_action_id_idx ON action_run_step (undo_action_id)
  WHERE undo_action_id IS NOT NULL;
CREATE INDEX action_run_step_review_item_id_idx ON action_run_step (review_item_id)
  WHERE review_item_id IS NOT NULL;
CREATE TRIGGER action_run_step_set_updated_at_trg BEFORE UPDATE ON action_run_step
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- A "flag" decision made in enforce mode puts the comment in the review queue.
-- decision.actor_type is one of user/rule/classifier/policy, all valid sources.
CREATE FUNCTION fb_review_item_from_decision() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.review_item (organization_id, brand_id, connection_id, comment_id, source, decision_id, rule_id)
  SELECT NEW.organization_id, NEW.brand_id, c.connection_id, NEW.comment_id, NEW.actor_type, NEW.id, NEW.rule_id
    FROM public.comment c
   WHERE c.organization_id = NEW.organization_id AND c.brand_id = NEW.brand_id AND c.id = NEW.comment_id
  ON CONFLICT (comment_id) WHERE status = 'open' DO NOTHING;
  RETURN NULL;
END
$$;
CREATE TRIGGER review_item_from_decision_trg AFTER INSERT ON decision
  FOR EACH ROW WHEN (NEW.outcome = 'flag' AND NEW.mode = 'enforce')
  EXECUTE FUNCTION fb_review_item_from_decision();

COMMIT;
