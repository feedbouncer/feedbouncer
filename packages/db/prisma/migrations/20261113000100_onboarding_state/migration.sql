BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE onboarding_state (
  organization_id uuid NOT NULL,
  brand_id uuid,
  run integer NOT NULL DEFAULT 1,
  connect_status text NOT NULL DEFAULT 'pending',
  defaults_status text NOT NULL DEFAULT 'pending',
  review_mode_status text NOT NULL DEFAULT 'pending',
  report_status text NOT NULL DEFAULT 'pending',
  review_mode_choice text,
  started_by_user_id uuid,
  last_actor_user_id uuid,
  dismissed_at timestamptz(3),
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_state_pkey PRIMARY KEY (organization_id),
  CONSTRAINT onboarding_state_run_check CHECK (run >= 1),
  CONSTRAINT onboarding_state_step_status_check CHECK (
    connect_status IN ('pending','done') AND defaults_status IN ('pending','done')
    AND review_mode_status IN ('pending','done') AND report_status IN ('pending','done')),
  CONSTRAINT onboarding_state_review_mode_choice_check CHECK (
    review_mode_choice IS NULL OR review_mode_choice IN ('review','automatic')),
  CONSTRAINT onboarding_state_completed_check CHECK ((completed_at IS NOT NULL) = (
    connect_status = 'done' AND defaults_status = 'done'
    AND review_mode_status = 'done' AND report_status = 'done')),
  CONSTRAINT onboarding_state_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT onboarding_state_brand_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE SET NULL (brand_id),
  CONSTRAINT onboarding_state_started_by_user_id_fkey FOREIGN KEY (started_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL,
  CONSTRAINT onboarding_state_last_actor_user_id_fkey FOREIGN KEY (last_actor_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);

CREATE INDEX onboarding_state_brand_id_idx ON onboarding_state (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX onboarding_state_started_by_user_id_idx
  ON onboarding_state (started_by_user_id) WHERE started_by_user_id IS NOT NULL;
CREATE INDEX onboarding_state_last_actor_user_id_idx
  ON onboarding_state (last_actor_user_id) WHERE last_actor_user_id IS NOT NULL;

CREATE TRIGGER onboarding_state_set_updated_at_trg BEFORE UPDATE ON onboarding_state
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

COMMIT;
