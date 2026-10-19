BEGIN;
SET LOCAL lock_timeout = '10s';

-- Public API keys. Only sha256 of the secret part is stored; the plaintext key is shown once.
CREATE TABLE api_key (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  public_id text NOT NULL,
  secret_sha256 bytea NOT NULL,
  scope text NOT NULL,
  created_by_user_id uuid,
  last_used_at timestamptz(3),
  revoked_at timestamptz(3),
  revoked_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT api_key_pkey PRIMARY KEY (id),
  CONSTRAINT api_key_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT api_key_public_id_key UNIQUE (public_id),
  CONSTRAINT api_key_name_check CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT api_key_public_id_check CHECK (public_id ~ '^[a-z2-7]{16}$'),
  CONSTRAINT api_key_secret_sha256_check CHECK (octet_length(secret_sha256) = 32),
  CONSTRAINT api_key_scope_check CHECK (scope IN ('read', 'write')),
  CONSTRAINT api_key_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT api_key_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL,
  CONSTRAINT api_key_revoked_by_user_id_fkey FOREIGN KEY (revoked_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX api_key_active_name_key ON api_key (organization_id, lower(name)) WHERE revoked_at IS NULL;
CREATE INDEX api_key_created_by_user_id_idx ON api_key (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX api_key_revoked_by_user_id_idx ON api_key (revoked_by_user_id) WHERE revoked_by_user_id IS NOT NULL;
CREATE TRIGGER api_key_set_updated_at_trg BEFORE UPDATE ON api_key
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- Stored responses for Idempotency-Key replays, scoped per key and kept 24 hours.
CREATE TABLE api_idempotency_record (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 bytea NOT NULL,
  state text NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT api_idempotency_record_pkey PRIMARY KEY (id),
  CONSTRAINT api_idempotency_record_api_key_id_idempotency_key_key UNIQUE (api_key_id, idempotency_key),
  CONSTRAINT api_idempotency_record_idempotency_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT api_idempotency_record_request_sha256_check CHECK (octet_length(request_sha256) = 32),
  CONSTRAINT api_idempotency_record_state_check CHECK (state IN ('in_progress', 'completed')),
  CONSTRAINT api_idempotency_record_response_status_check CHECK (response_status BETWEEN 100 AND 599),
  CONSTRAINT api_idempotency_record_response_body_check CHECK (octet_length(response_body::text) <= 65536),
  CONSTRAINT api_idempotency_record_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT api_idempotency_record_organization_id_api_key_id_fkey FOREIGN KEY (organization_id, api_key_id)
    REFERENCES api_key (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX api_idempotency_record_organization_id_idx ON api_idempotency_record (organization_id);
CREATE INDEX api_idempotency_record_expires_at_idx ON api_idempotency_record (expires_at);
CREATE TRIGGER api_idempotency_record_set_updated_at_trg BEFORE UPDATE ON api_idempotency_record
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

-- An api_key row may lose its key id when the key row is erased; presence at insert time
-- is enforced by the ActionActor type, not here.
ALTER TABLE moderation_action ADD COLUMN actor_api_key_id uuid;
ALTER TABLE moderation_action ADD CONSTRAINT moderation_action_organization_id_actor_api_key_id_fkey
  FOREIGN KEY (organization_id, actor_api_key_id) REFERENCES api_key (organization_id, id)
  ON DELETE SET NULL (actor_api_key_id) NOT VALID;
CREATE INDEX moderation_action_actor_api_key_id_idx ON moderation_action (actor_api_key_id)
  WHERE actor_api_key_id IS NOT NULL;
ALTER TABLE moderation_action DROP CONSTRAINT moderation_action_actor_type_check,
  ADD CONSTRAINT moderation_action_actor_type_check CHECK (actor_type IN ('user', 'rule', 'classifier', 'system', 'policy', 'api_key')) NOT VALID,
  ADD CONSTRAINT moderation_action_api_key_actor_check CHECK (actor_type = 'api_key' OR actor_api_key_id IS NULL) NOT VALID;
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_type_check,
  ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'rule', 'classifier', 'policy', 'api_key')) NOT VALID;

-- The existing (organization_id, posted_at) index is partial to visible comments, so hidden/deleted listings need this one.
CREATE INDEX comment_org_posted_idx ON comment (organization_id, posted_at DESC, id DESC);

COMMIT;
