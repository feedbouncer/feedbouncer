-- Review mode: a 168-hour window after a connection is set up in which automation only
-- suggests. Adds the window columns, a per-evaluation snapshot of the mode, the suggestion
-- queue with its sources, and approval runs that execute a suggestion's merged plan.
BEGIN;

SET LOCAL lock_timeout = '10s';

-- Rows that exist now were connected before this release and are never gated: add the
-- column defaulting to 'legacy', then make 'on' the default for new rows.
ALTER TABLE connection
  ADD COLUMN review_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN review_mode_started_at timestamptz(3),
  ADD COLUMN review_mode_ends_at timestamptz(3),
  ADD COLUMN review_mode_ended_at timestamptz(3),
  ADD COLUMN review_mode_ended_by_user_id uuid,
  ADD CONSTRAINT connection_review_mode_check CHECK (review_mode IN ('legacy', 'on', 'opted_out')),
  ADD CONSTRAINT connection_review_mode_window_check CHECK (
    (review_mode_started_at IS NULL) = (review_mode_ends_at IS NULL)
    AND (review_mode_ends_at IS NULL OR review_mode_ends_at = review_mode_started_at + interval '168 hours')),
  ADD CONSTRAINT connection_review_mode_started_check CHECK (
    review_mode = 'on' OR review_mode_started_at IS NULL),
  ADD CONSTRAINT connection_review_mode_ended_check CHECK (
    review_mode_ended_at IS NULL
    OR (review_mode = 'on' AND review_mode_started_at IS NOT NULL AND review_mode_ended_at >= review_mode_started_at)),
  ADD CONSTRAINT connection_review_mode_ended_by_user_id_fkey FOREIGN KEY (review_mode_ended_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL;
ALTER TABLE connection ALTER COLUMN review_mode SET DEFAULT 'on';
CREATE INDEX connection_review_mode_ended_by_user_id_idx ON connection (review_mode_ended_by_user_id)
  WHERE review_mode_ended_by_user_id IS NOT NULL;

-- A row that was never activated was not "connected before release".
UPDATE connection SET review_mode = 'on'
 WHERE status = 'reconnect_required' AND status_reason = 'oauth_pending'
   AND NOT EXISTS (SELECT 1 FROM audit_event a
                    WHERE a.action = 'connection.authorized' AND a.subject_type = 'connection'
                      AND a.subject_id = connection.id);

-- Whether review mode applied when the evaluation ran, and the other rules that matched
-- alongside the winning one.
ALTER TABLE rule_evaluation
  ADD COLUMN review_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN also_matched_rule_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT rule_evaluation_also_matched_rule_ids_check CHECK (cardinality(also_matched_rule_ids) <= 50);
ALTER TABLE comment_classification ADD COLUMN review_mode boolean NOT NULL DEFAULT false;
ALTER TABLE policy_evaluation ADD COLUMN review_mode boolean NOT NULL DEFAULT false;

-- What automation would have done to a comment, waiting for a human. At most one pending
-- suggestion per comment.
CREATE TABLE action_suggestion (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  author_id uuid,
  body_sha256 bytea NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  status_reason text,
  decided_by_user_id uuid,
  decided_at timestamptz(3),
  request_key text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT action_suggestion_pkey PRIMARY KEY (id),
  CONSTRAINT action_suggestion_brand_id_id_key UNIQUE (brand_id, id),
  CONSTRAINT action_suggestion_id_comment_id_key UNIQUE (id, comment_id),
  CONSTRAINT action_suggestion_status_check CHECK (
    status IN ('pending', 'approved', 'dismissed', 'expired', 'not_applicable', 'withdrawn')),
  CONSTRAINT action_suggestion_status_reason_check CHECK (
    status_reason IS NULL OR status_reason ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT action_suggestion_decided_check CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT action_suggestion_request_key_check CHECK (
    request_key IS NULL OR status IN ('approved', 'dismissed')),
  CONSTRAINT action_suggestion_body_sha256_check CHECK (octet_length(body_sha256) = 32),
  CONSTRAINT action_suggestion_connection_id_fkey FOREIGN KEY (organization_id, brand_id, connection_id)
    REFERENCES connection (organization_id, brand_id, id) ON DELETE CASCADE,
  CONSTRAINT action_suggestion_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT action_suggestion_author_id_fkey FOREIGN KEY (connection_id, author_id)
    REFERENCES author (connection_id, id) ON DELETE SET NULL (author_id),
  CONSTRAINT action_suggestion_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX action_suggestion_pending_comment_key ON action_suggestion (comment_id)
  WHERE status = 'pending';
CREATE INDEX action_suggestion_queue_idx
  ON action_suggestion (organization_id, brand_id, status, created_at DESC, id DESC);
CREATE INDEX action_suggestion_connection_id_status_idx ON action_suggestion (connection_id, status);
CREATE INDEX action_suggestion_pending_author_idx ON action_suggestion (connection_id, author_id)
  WHERE status = 'pending';
CREATE INDEX action_suggestion_comment_id_idx ON action_suggestion (comment_id);
CREATE INDEX action_suggestion_author_id_idx ON action_suggestion (author_id) WHERE author_id IS NOT NULL;
CREATE INDEX action_suggestion_decided_by_user_id_idx ON action_suggestion (decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;
-- The comment's own connection must be the suggestion's connection (the FKs only prove both
-- belong to the same brand). A missing or other-brand comment is left to the comment foreign key.
CREATE FUNCTION action_suggestion_check_comment_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM comment WHERE id = NEW.comment_id AND brand_id = NEW.brand_id AND connection_id <> NEW.connection_id) THEN
    RAISE EXCEPTION 'action_suggestion comment % does not belong to connection %', NEW.comment_id, NEW.connection_id
      USING ERRCODE = '23514', CONSTRAINT = 'action_suggestion_comment_connection_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER action_suggestion_comment_connection_trg BEFORE INSERT OR UPDATE OF connection_id, comment_id
  ON action_suggestion FOR EACH ROW EXECUTE FUNCTION action_suggestion_check_comment_connection();
CREATE TRIGGER action_suggestion_set_updated_at_trg BEFORE UPDATE ON action_suggestion
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Why a suggestion exists: one row per rule, classifier verdict or policy that proposed it.
CREATE TABLE action_suggestion_source (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  suggestion_id uuid NOT NULL,
  source_type text NOT NULL,
  source_ref uuid NOT NULL,
  rule_id uuid,
  also_matched_rule_ids uuid[] NOT NULL DEFAULT '{}',
  steps jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT action_suggestion_source_pkey PRIMARY KEY (id),
  CONSTRAINT action_suggestion_source_ref_key UNIQUE (suggestion_id, source_type, source_ref),
  CONSTRAINT action_suggestion_source_source_type_check CHECK (source_type IN ('rule', 'classifier', 'policy')),
  CONSTRAINT action_suggestion_source_rule_id_check CHECK ((source_type = 'rule') = (rule_id IS NOT NULL)),
  CONSTRAINT action_suggestion_source_steps_check CHECK (
    jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 5),
  CONSTRAINT action_suggestion_source_reason_check CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT action_suggestion_source_also_matched_rule_ids_check CHECK (
    cardinality(also_matched_rule_ids) <= 50),
  CONSTRAINT action_suggestion_source_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT action_suggestion_source_suggestion_id_fkey FOREIGN KEY (brand_id, suggestion_id)
    REFERENCES action_suggestion (brand_id, id) ON DELETE CASCADE,
  -- Deferred like action_run's rule FK so brand/org cascades can remove the rule;
  -- a direct rule delete still fails at commit. Retire rules with archived_at.
  CONSTRAINT action_suggestion_source_rule_id_fkey FOREIGN KEY (brand_id, rule_id)
    REFERENCES rule (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX action_suggestion_source_brand_id_idx ON action_suggestion_source (brand_id);
CREATE INDEX action_suggestion_source_rule_id_idx ON action_suggestion_source (rule_id)
  WHERE rule_id IS NOT NULL;
CREATE TRIGGER action_suggestion_source_set_updated_at_trg BEFORE UPDATE ON action_suggestion_source
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- A run is either a rule's steps for one evaluation or the approval of one suggestion.
ALTER TABLE action_run
  ALTER COLUMN rule_id DROP NOT NULL,
  ALTER COLUMN rule_evaluation_id DROP NOT NULL,
  ADD COLUMN suggestion_id uuid,
  ADD COLUMN approved_by_user_id uuid,
  ADD CONSTRAINT action_run_origin_check CHECK (
    (suggestion_id IS NULL AND rule_id IS NOT NULL AND rule_evaluation_id IS NOT NULL)
    OR (suggestion_id IS NOT NULL AND rule_id IS NULL AND rule_evaluation_id IS NULL)),
  ADD CONSTRAINT action_run_approver_check CHECK (approved_by_user_id IS NULL OR suggestion_id IS NOT NULL),
  ADD CONSTRAINT action_run_suggestion_id_fkey FOREIGN KEY (brand_id, suggestion_id)
    REFERENCES action_suggestion (brand_id, id) ON DELETE CASCADE,
  -- MATCH SIMPLE: rule runs (NULL suggestion_id) are not checked. A suggestion run must be
  -- for the suggestion's own comment.
  ADD CONSTRAINT action_run_suggestion_comment_fkey FOREIGN KEY (suggestion_id, comment_id)
    REFERENCES action_suggestion (id, comment_id) ON DELETE CASCADE,
  ADD CONSTRAINT action_run_approved_by_user_id_fkey FOREIGN KEY (approved_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX action_run_suggestion_key ON action_run (suggestion_id) WHERE suggestion_id IS NOT NULL;
CREATE INDEX action_run_approved_by_user_id_idx ON action_run (approved_by_user_id)
  WHERE approved_by_user_id IS NOT NULL;

COMMIT;
