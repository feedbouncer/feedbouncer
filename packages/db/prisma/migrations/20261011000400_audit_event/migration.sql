-- Append-only record of significant changes. details must never contain
-- credentials or comment bodies (see packages/db/README.md).
BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE audit_event (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  organization_id uuid NOT NULL,
  brand_id uuid,
  actor_type text NOT NULL,
  actor_user_id uuid,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT audit_event_pkey PRIMARY KEY (id),
  CONSTRAINT audit_event_sequence_key UNIQUE (sequence),
  CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'rule', 'classifier')),
  CONSTRAINT audit_event_action_check CHECK (char_length(action) <= 100 AND action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  CONSTRAINT audit_event_subject_type_check CHECK (char_length(subject_type) <= 50 AND subject_type ~ '^[a-z][a-z_]*$'),
  CONSTRAINT audit_event_details_check CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 65536),
  CONSTRAINT audit_event_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT audit_event_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE SET NULL (brand_id),
  CONSTRAINT audit_event_actor_user_id_fkey FOREIGN KEY (actor_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX audit_event_organization_id_sequence_idx ON audit_event (organization_id, sequence DESC);
CREATE INDEX audit_event_brand_id_idx ON audit_event (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX audit_event_actor_user_id_idx ON audit_event (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_event_organization_id_subject_type_subject_id_idx ON audit_event (organization_id, subject_type, subject_id);
CREATE TRIGGER audit_event_append_only_trg BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION fb_forbid_direct_mutation();
CREATE TRIGGER audit_event_no_truncate_trg BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION fb_forbid_direct_mutation();

COMMIT;
