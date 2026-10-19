-- Forward migration. Keep everything between BEGIN; and COMMIT;: Prisma runs this
-- file statement by statement, so the explicit transaction is what makes it atomic.
-- Never use CREATE INDEX CONCURRENTLY here. State ON DELETE on every REFERENCES.
-- Conventions: packages/db/README.md
BEGIN;
SET LOCAL lock_timeout = '10s';

-- A rule change proposed through the public API. It changes no rule until a person approves it.
-- A pending row whose expires_at has passed reads as expired; no job sweeps it.
CREATE TABLE rule_change_proposal (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  operation text NOT NULL,
  target_rule_id uuid,
  before jsonb,
  after jsonb,
  diff jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text,
  -- brand.rule_revision when proposed; approval refuses a proposal whose base has moved.
  base_rule_revision bigint NOT NULL,
  proposed_by_api_key_id uuid NOT NULL,
  request_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz(3) NOT NULL,
  decided_by_user_id uuid,
  decided_at timestamptz(3),
  decision_note text,
  applied_rule_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT rule_change_proposal_pkey PRIMARY KEY (id),
  CONSTRAINT rule_change_proposal_organization_id_request_key_key UNIQUE (organization_id, request_key),
  CONSTRAINT rule_change_proposal_operation_check CHECK (operation IN ('create', 'update', 'archive')),
  CONSTRAINT rule_change_proposal_target_check CHECK ((operation = 'create') = (target_rule_id IS NULL)),
  CONSTRAINT rule_change_proposal_rationale_check CHECK (char_length(rationale) <= 1000),
  CONSTRAINT rule_change_proposal_request_key_check CHECK (char_length(request_key) <= 200),
  CONSTRAINT rule_change_proposal_status_check CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired', 'stale')),
  CONSTRAINT rule_change_proposal_decision_note_check CHECK (char_length(decision_note) <= 500),
  CONSTRAINT rule_change_proposal_decided_check CHECK (
    (status IN ('approved', 'rejected')) = (decided_by_user_id IS NOT NULL)),
  CONSTRAINT rule_change_proposal_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT rule_change_proposal_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  -- Deferred like action_run's rule FK so brand/org cascades can remove the rule;
  -- a direct rule delete still fails at commit. Retire rules with archived_at.
  CONSTRAINT rule_change_proposal_target_rule_id_fkey FOREIGN KEY (brand_id, target_rule_id)
    REFERENCES rule (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT rule_change_proposal_applied_rule_id_fkey FOREIGN KEY (brand_id, applied_rule_id)
    REFERENCES rule (brand_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT rule_change_proposal_proposed_by_api_key_id_fkey FOREIGN KEY (organization_id, proposed_by_api_key_id)
    REFERENCES api_key (organization_id, id) ON DELETE CASCADE,
  -- Same target and ON DELETE as membership.user_id: SET NULL would break the decided check.
  CONSTRAINT rule_change_proposal_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id)
    REFERENCES app_user (id) ON DELETE CASCADE
);
CREATE INDEX rule_change_proposal_brand_status_idx ON rule_change_proposal (brand_id, status, created_at DESC);
CREATE INDEX rule_change_proposal_target_rule_id_idx ON rule_change_proposal (target_rule_id)
  WHERE target_rule_id IS NOT NULL;
CREATE INDEX rule_change_proposal_applied_rule_id_idx ON rule_change_proposal (applied_rule_id)
  WHERE applied_rule_id IS NOT NULL;
CREATE INDEX rule_change_proposal_proposed_by_api_key_id_idx ON rule_change_proposal (proposed_by_api_key_id);
CREATE INDEX rule_change_proposal_decided_by_user_id_idx ON rule_change_proposal (decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;
CREATE TRIGGER rule_change_proposal_set_updated_at_trg BEFORE UPDATE ON rule_change_proposal
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
